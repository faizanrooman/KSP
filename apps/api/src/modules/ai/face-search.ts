/**
 * Repository-wide suspect (face) search (tender Appendix 1 §20).
 *
 *   POST /ai/face-searches                 {imageBase64, threshold?, limit?} -> {id}   (ai:request)
 *   GET  /ai/face-searches                 my recent searches
 *   GET  /ai/face-searches/:id             status + matches limited to evidence the caller may see (+ hidden count)
 *   GET  /ai/face-searches/:id/probe       the uploaded probe image (owner only)
 *
 * The API never runs inference: it stores the probe in the derived bucket and wakes the isolated AI worker, which
 * writes the raw top-K matches. Visibility filtering (evidenceVisibleSql) happens here, per request, so a result set
 * computed once can never leak evidence the viewer is not allowed to see. Every request, completion and view is audited.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { aiTaskGates, appendAudit, loadConfig, sha256Hex } from '@ksp/core';
import { AI_JOBS_CHANNEL } from '@ksp/shared';
import { evidenceVisibleSql } from '../../lib/access.js';
import { AppError, forbidden, notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { hasPermission } from '../../lib/principal.js';
import { getSettings } from '../../lib/settings.js';
import { sendObject } from '../media/stream.js';
import { cropUrl } from './common.js';
import { sniffImage } from './watchlists.js';

const MAX_PROBE_BYTES = 3 * 1024 * 1024;
const idParams = z.object({ id: z.string().uuid() });

interface RawMatch {
  detectionId: string;
  evidenceId: string;
  similarity: number;
  frameTimeMs: number | null;
}

export default async function faceSearchRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const requireAi = (req: FastifyRequest) => {
    const p = req.requirePrincipal();
    if (!hasPermission(p, 'ai:request')) throw forbidden();
    if (!p.userId) throw forbidden('Only users can run face searches');
    return p;
  };

  app.post('/face-searches', {
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10000 : 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['ai'],
      summary: 'Search every stored face in the repository for the person in a probe photograph',
      body: z.object({ imageBase64: z.string().min(16).max(4 * 1024 * 1024), threshold: z.number().min(0).max(1).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
    },
  }, async (req, reply) => {
    const p = requireAi(req);
    // Same deployment + legal gate as FACE_RECOGNITION jobs (EXT-5 DPIA): a refused task never reaches the worker.
    const gate = aiTaskGates(loadConfig(), (await getSettings(app.db)).aiLegalApprovals).FACE_RECOGNITION;
    if (!gate.allowed) {
      await appendAudit(app.db, req.actor(), { action: 'AI_TASK_REFUSED', outcome: 'FAILURE', resourceType: 'face_search', orgUnitId: p.homeOrgUnitId, details: { tasks: ['FACE_RECOGNITION'], reasons: { FACE_RECOGNITION: gate.reason } } });
      throw new AppError(422, 'AI_TASK_DISABLED', `Not permitted on this deployment: face recognition (${gate.explanation})`, { tasks: [{ task: 'FACE_RECOGNITION', reason: gate.reason, explanation: gate.explanation }] });
    }
    const active = await app.db.selectFrom('ai_models').select('id').where('task', '=', 'FACE_RECOGNITION').where('status', '=', 'ACTIVE').executeTakeFirst();
    if (!active) throw unprocessable('No ACTIVE face-recognition model is registered');
    const buf = Buffer.from(req.body.imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
    if (buf.length > MAX_PROBE_BYTES) throw unprocessable(`Probe image exceeds ${MAX_PROBE_BYTES} bytes`);
    const kind = sniffImage(buf);
    if (!kind) throw validationFailed('Probe must be a JPEG or PNG image');
    const id = await app.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('face_searches')
        .values({ requested_by: p.userId!, org_unit_id: p.homeOrgUnitId, probe_key: 'pending', params: JSON.stringify({ threshold: req.body.threshold, limit: req.body.limit ?? 50 }) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const key = `ai/face-searches/${row.id}/probe.${kind.ext}`;
      await app.storage.put(app.storage.bucket('derived'), key, buf, { contentType: kind.mime, metadata: { 'face-search': row.id } });
      await tx.updateTable('face_searches').set({ probe_key: key }).where('id', '=', row.id).execute();
      await appendAudit(tx, req.actor(), {
        action: 'AI_FACE_SEARCH_REQUESTED', resourceType: 'face_search', resourceId: row.id, orgUnitId: p.homeOrgUnitId,
        details: { probeSha256: sha256Hex(buf), bytes: buf.length, threshold: req.body.threshold ?? null, limit: req.body.limit ?? 50 },
      });
      return row.id;
    });
    await sql`SELECT pg_notify(${AI_JOBS_CHANNEL}, 'face-search')`.execute(app.db);
    return reply.status(202).send({ id, status: 'QUEUED' });
  });

  app.get('/face-searches', { schema: { tags: ['ai'], summary: 'My recent face searches' } }, async (req) => {
    const p = requireAi(req);
    const rows = await app.db.selectFrom('face_searches').selectAll().where('requested_by', '=', p.userId!).orderBy('created_at', 'desc').limit(20).execute();
    return { items: rows.map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at, params: r.params, stats: r.stats, error: r.error, matches: Array.isArray(r.result) ? (r.result as unknown[]).map(() => ({})) : [], hiddenMatches: 0, probeUrl: `/api/v1/ai/face-searches/${r.id}/probe` })) };
  });

  app.get('/face-searches/:id', { schema: { tags: ['ai'], summary: 'Face search status and visible matches', params: idParams } }, async (req) => {
    const p = requireAi(req);
    const r = await app.db.selectFrom('face_searches').selectAll().where('id', '=', req.params.id).where('requested_by', '=', p.userId!).executeTakeFirst();
    if (!r) throw notFound('Face search');
    const raw = (Array.isArray(r.result) ? r.result : []) as unknown as RawMatch[];
    let matches: Array<Record<string, unknown>> = [];
    let hidden = 0;
    if (raw.length) {
      const visible = await app.db
        .selectFrom('ai_detections as d')
        .innerJoin('evidence as e', 'e.id', 'd.evidence_id')
        .leftJoin('org_units as o', 'o.id', 'e.org_unit_id')
        .select(['d.id', 'd.evidence_id', 'd.crop_key', 'd.review_status', 'd.frame_time_ms', 'e.evidence_number', 'e.title', 'e.recorded_at', 'o.name as org_name'])
        .where('d.id', 'in', raw.map((m) => m.detectionId))
        .where(evidenceVisibleSql(p, 'e'))
        .execute();
      const byId = new Map(visible.map((v) => [v.id, v]));
      for (const m of raw) {
        const v = byId.get(m.detectionId);
        if (!v) { hidden++; continue; }
        matches.push({
          detectionId: m.detectionId, evidenceId: m.evidenceId, evidenceNumber: v.evidence_number, title: v.title, orgUnitName: v.org_name,
          recordedAt: v.recorded_at, similarity: m.similarity, frameTimeMs: m.frameTimeMs, reviewStatus: v.review_status,
          cropUrl: cropUrl(p, m.evidenceId, m.detectionId, !!v.crop_key),
        });
      }
      matches = matches.sort((a, b) => (b.similarity as number) - (a.similarity as number));
      if (r.status === 'COMPLETED') {
        await appendAudit(app.db, req.actor(), { action: 'AI_FACE_SEARCH_VIEWED', resourceType: 'face_search', resourceId: r.id, orgUnitId: r.org_unit_id, details: { visibleMatches: matches.length, hiddenMatches: hidden } });
      }
    }
    return { id: r.id, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at, params: r.params, stats: r.stats, error: r.error, matches, hiddenMatches: hidden, probeUrl: `/api/v1/ai/face-searches/${r.id}/probe` };
  });

  app.get('/face-searches/:id/probe', { schema: { tags: ['ai'], summary: 'Probe image of one of my face searches', params: idParams } }, async (req, reply) => {
    const p = requireAi(req);
    const r = await app.db.selectFrom('face_searches').select(['probe_key']).where('id', '=', req.params.id).where('requested_by', '=', p.userId!).executeTakeFirst();
    if (!r || r.probe_key === 'pending') throw notFound('Face search');
    return sendObject(app.storage, req, reply, { bucket: app.storage.bucket('derived'), key: r.probe_key, contentType: r.probe_key.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  });
}
