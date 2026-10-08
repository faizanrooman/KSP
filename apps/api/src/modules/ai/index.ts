/**
 * AI analysis (spec module 8). The API never runs inference: it validates, snapshots the derived PROXY_MP4 location
 * into ai_jobs.input and NOTIFYs the isolated ai-worker (role ksp_ai). Results stay PENDING until human review.
 *
 *   GET  /ai/tasks                               tasks + ACTIVE model per task
 *   POST /ai/evidence/:id/jobs                   request analysis (ai:request)
 *   GET  /ai/evidence/:id/jobs                   jobs for an evidence item
 *   GET  /ai/evidence/:id/watchlists             watchlists applicable to the evidence jurisdiction
 *   GET  /ai/evidence/:id/detections             detections (filters) with tokenised crop URLs
 *   GET  /ai/jobs/:id  ·  POST /ai/jobs/:id/cancel
 *   GET  /ai/crops/:detectionId?t=               crop image by media token (public route, token-authenticated)
 *   models, watchlists, training exports: ./models.ts, ./watchlists.ts, ./training.ts
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit } from '@ksp/core';
import { AI_SAMPLE_FPS, AI_TASK_INFO, AI_TASKS, REVIEW_STATUSES, type AiJobInput, type AiJobParams, type AiTask, type AiTaskDto } from '@ksp/shared';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { authenticateMediaToken } from '../media/tokens.js';
import { sendObject } from '../media/stream.js';
import { AI_READ_PERMS, anyOf, auditResultsViewed, detectionDto, detectionQuery, jobDtos, jobQuery, loadEvidenceForAi, notifyAiWorker, type JobRow } from './common.js';
import modelRoutes from './models.js';
import watchlistRoutes from './watchlists.js';
import trainingRoutes from './training.js';
import faceSearchRoutes from './face-search.js';

export const prefix = '/ai';

const idParams = z.object({ id: z.string().uuid() });
const task = z.enum(AI_TASKS);
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().optional().transform((v, ctx) => {
    if (!v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    for (const x of parts) if (!(values as readonly string[]).includes(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid value ${x}` });
    return parts as T[number][];
  });

const jobBody = z.object({
  tasks: z.array(task).min(1).max(AI_TASKS.length).refine((t) => new Set(t).size === t.length, 'duplicate task'),
  sampleFps: z.number().min(AI_SAMPLE_FPS.min).max(AI_SAMPLE_FPS.max).optional(),
  thresholds: z.record(task, z.number().min(0.05).max(0.99)).optional(),
  watchlistIds: z.array(z.string().uuid()).max(50).optional(),
  keepEveryMs: z.number().int().min(1000).max(600_000).optional(),
  crowdMinPersons: z.number().int().min(2).max(500).optional(),
}).strict();

/** Tasks each task needs to run (the worker runs dependencies internally without storing their output). */
const DEPENDENCIES: Record<AiTask, AiTask[][]> = {
  PERSON_DETECTION: [], OBJECT_DETECTION: [], FACE_DETECTION: [], ANPR: [],
  FACE_RECOGNITION: [['FACE_DETECTION']],
  CLASSIFICATION: [['OBJECT_DETECTION'], ['PERSON_DETECTION']],
};

async function activeModels(db: FastifyInstance['db']) {
  return db.selectFrom('ai_models').selectAll().where('status', '=', 'ACTIVE').orderBy('activated_at', 'desc').execute();
}

export default async function ai(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  await app.register(modelRoutes);
  await app.register(watchlistRoutes);
  await app.register(trainingRoutes);
  await app.register(faceSearchRoutes);

  app.get('/tasks', {
    preHandler: anyOf('ai:request', 'ai:review', 'ai:models_manage'),
    schema: { tags: ['ai'], summary: 'AI tasks and their ACTIVE models' },
  }, async () => {
    const models = await activeModels(app.db);
    const has = (t: AiTask) => models.some((m) => m.task === t);
    const items: AiTaskDto[] = AI_TASKS.map((t) => ({
      task: t, label: AI_TASK_INFO[t].label, description: AI_TASK_INFO[t].description,
      available: has(t) && (DEPENDENCIES[t].length === 0 || DEPENDENCIES[t].some((alt) => alt.every(has))),
      models: models.filter((m) => m.task === t).map((m) => ({ id: m.id, code: m.code, name: m.name, version: m.version, defaultThreshold: Number(m.default_threshold), labels: m.labels, licence: ((m.config as { licence?: string }).licence) ?? null })),
    }));
    return { items };
  });

  app.post('/evidence/:id/jobs', {
    preHandler: app.authorize('ai:request'),
    schema: { tags: ['ai'], summary: 'Request AI analysis of an evidence item (runs on the derived proxy)', params: idParams, body: jobBody },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceForAi(app.db, req, req.params.id, 'ai:request');
    const body = req.body;
    const e = await app.db.selectFrom('evidence').select(['status', 'media_status', 'duration_ms', 'frame_rate', 'width', 'height', 'org_path']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (!['REGISTERED', 'DISPOSAL_PENDING'].includes(e.status)) throw conflict(`Evidence in status ${e.status} cannot be analysed`);
    if (e.media_status !== 'READY') throw new AppError(409, 'MEDIA_NOT_READY', 'Media processing has not produced a playable proxy yet');
    const proxy = await app.db.selectFrom('evidence_derivatives').select(['id', 'bucket', 'object_key', 'width', 'height'])
      .where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').orderBy('created_at', 'desc').executeTakeFirst();
    if (!proxy) throw new AppError(409, 'NO_PROXY', 'No PROXY_MP4 derivative exists for this evidence');
    if (proxy.bucket !== app.storage.bucket('derived')) throw new AppError(409, 'NO_PROXY', 'Proxy is not in the derived bucket');

    const models = await activeModels(app.db);
    const pickModel = (t: AiTask) => models.find((m) => m.task === t);
    const modelIds = new Set<string>();
    const unavailable: AiTask[] = [];
    for (const t of body.tasks) {
      const m = pickModel(t);
      if (!m) { unavailable.push(t); continue; }
      modelIds.add(m.id);
      const deps = DEPENDENCIES[t];
      if (deps.length) {
        const alt = deps.find((a) => a.every((d) => pickModel(d)));
        if (!alt) { unavailable.push(t); continue; }
        for (const d of alt) modelIds.add(pickModel(d)!.id);
      }
    }
    if (unavailable.length) throw unprocessable('Some tasks have no ACTIVE model and cannot run', { unavailable });

    // Watchlists: only lists whose org unit covers the evidence jurisdiction.
    const wants = body.tasks.filter((t) => t === 'FACE_RECOGNITION' || t === 'ANPR');
    let watchlistIds: string[] = [];
    if (wants.length) {
      const applicable = await app.db.selectFrom('ai_watchlists as w').innerJoin('org_units as ou', 'ou.id', 'w.org_unit_id')
        .select(['w.id', 'w.kind']).where(sql<boolean>`ou.path @> ${e.org_path}::ltree`).execute();
      const kinds = new Set<string>([...(body.tasks.includes('FACE_RECOGNITION') ? ['FACE'] : []), ...(body.tasks.includes('ANPR') ? ['VEHICLE'] : [])]);
      if (body.watchlistIds) {
        const ok = new Map(applicable.map((w) => [w.id, w.kind]));
        const bad = body.watchlistIds.filter((id) => !ok.has(id) || !kinds.has(ok.get(id)!));
        if (bad.length) throw unprocessable('Watchlists not applicable to this evidence', { watchlistIds: bad });
        watchlistIds = body.watchlistIds;
      } else {
        watchlistIds = applicable.filter((w) => kinds.has(w.kind)).map((w) => w.id);
      }
      if (body.tasks.includes('FACE_RECOGNITION') && !applicable.some((w) => w.kind === 'FACE' && watchlistIds.includes(w.id))) {
        throw unprocessable('Face recognition needs at least one FACE watchlist covering this evidence jurisdiction');
      }
    }

    const params: AiJobParams = {
      sampleFps: body.sampleFps ?? AI_SAMPLE_FPS.default, thresholds: body.thresholds ?? {}, watchlistIds,
      keepEveryMs: body.keepEveryMs ?? 10_000, crowdMinPersons: body.crowdMinPersons ?? 8,
    };
    const input: AiJobInput = {
      derivativeBucket: proxy.bucket, derivativeKey: proxy.object_key, durationMs: e.duration_ms, frameRate: e.frame_rate,
      width: proxy.width ?? e.width, height: proxy.height ?? e.height, orgUnitId: ev.org_unit_id,
    };
    const job = await app.db.transaction().execute(async (tx) => {
      const j = await tx.insertInto('ai_jobs').values({
        evidence_id: ev.id, requested_by: p.userId!, tasks: body.tasks, input: JSON.stringify(input), params: JSON.stringify(params), model_ids: [...modelIds],
      }).returning('id').executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'AI_ANALYSIS_REQUESTED', resourceType: 'ai_job', resourceId: j.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
        details: { tasks: body.tasks, sampleFps: params.sampleFps, modelIds: [...modelIds], watchlists: watchlistIds.length, proxyDerivativeId: proxy.id },
      });
      await notifyAiWorker(tx, j.id);
      return j;
    });
    const rows = (await jobQuery(app.db).where('j.id', '=', job.id).execute()) as unknown as JobRow[];
    return reply.status(202).send((await jobDtos(app.db, rows))[0]);
  });

  app.get('/evidence/:id/jobs', {
    preHandler: anyOf(...AI_READ_PERMS),
    schema: { tags: ['ai'], summary: 'AI jobs for an evidence item', params: idParams },
  }, async (req) => {
    const ev = await loadEvidenceForAi(app.db, req, req.params.id);
    const rows = (await jobQuery(app.db).where('j.evidence_id', '=', ev.id).orderBy('j.created_at', 'desc').limit(100).execute()) as unknown as JobRow[];
    return { items: await jobDtos(app.db, rows) };
  });

  app.get('/evidence/:id/watchlists', {
    preHandler: app.authorize('ai:request'),
    schema: { tags: ['ai'], summary: 'Watchlists applicable to the evidence jurisdiction', params: idParams },
  }, async (req) => {
    const ev = await loadEvidenceForAi(app.db, req, req.params.id, 'ai:request');
    const rows = await app.db.selectFrom('ai_watchlists as w').innerJoin('org_units as ou', 'ou.id', 'w.org_unit_id')
      .select(['w.id', 'w.name', 'w.kind', 'ou.name as org_name',
        sql<number>`(SELECT count(*)::int FROM ai_watchlist_entries x WHERE x.watchlist_id = w.id)`.as('entries'),
        sql<number>`(SELECT count(*)::int FROM ai_watchlist_entries x WHERE x.watchlist_id = w.id AND (x.embedding IS NOT NULL OR x.plate_normalized IS NOT NULL))`.as('ready')])
      .where(sql<boolean>`ou.path @> ${ev.org_path}::ltree`).orderBy('w.name').execute();
    return { items: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, orgUnitName: r.org_name, entries: r.entries, readyEntries: r.ready })) };
  });

  app.get('/jobs/:id', {
    preHandler: anyOf(...AI_READ_PERMS),
    schema: { tags: ['ai'], summary: 'AI job status', params: idParams },
  }, async (req) => {
    const rows = (await jobQuery(app.db).where('j.id', '=', req.params.id).execute()) as unknown as JobRow[];
    if (!rows[0]) throw notFound('AI job');
    await loadEvidenceForAi(app.db, req, rows[0].evidence_id);
    return (await jobDtos(app.db, rows))[0];
  });

  app.post('/jobs/:id/cancel', {
    preHandler: app.authorize('ai:request'),
    schema: { tags: ['ai'], summary: 'Cancel a queued or running AI job', params: idParams },
  }, async (req) => {
    const j = await app.db.selectFrom('ai_jobs').select(['id', 'evidence_id', 'status']).where('id', '=', req.params.id).executeTakeFirst();
    if (!j) throw notFound('AI job');
    const ev = await loadEvidenceForAi(app.db, req, j.evidence_id, 'ai:request');
    await app.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ id: string; status: string }>`
        UPDATE ai_jobs SET status = 'CANCELLED', finished_at = now() WHERE id = ${j.id}::uuid AND status IN ('QUEUED','RUNNING') RETURNING id, status`.execute(tx);
      if (!rows.length) throw conflict(`Job is already ${j.status}`);
      await appendAudit(tx, req.actor(), { action: 'AI_ANALYSIS_CANCELLED', resourceType: 'ai_job', resourceId: j.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { previousStatus: j.status } });
      await notifyAiWorker(tx, `cancel:${j.id}`);
    });
    const rows = (await jobQuery(app.db).where('j.id', '=', j.id).execute()) as unknown as JobRow[];
    return (await jobDtos(app.db, rows))[0];
  });

  app.get('/evidence/:id/detections', {
    preHandler: anyOf(...AI_READ_PERMS),
    schema: {
      tags: ['ai'], summary: 'AI detections for an evidence item', params: idParams,
      querystring: z.object({
        task: csvEnum(AI_TASKS), reviewStatus: csvEnum(REVIEW_STATUSES), minConfidence: z.coerce.number().min(0).max(1).optional(),
        label: z.string().trim().max(100).optional(), jobId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(200),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceForAi(app.db, req, req.params.id);
    const q = req.query;
    let base = detectionQuery(app.db).where('d.evidence_id', '=', ev.id);
    if (q.task) base = base.where('d.task', 'in', q.task);
    if (q.reviewStatus) base = base.where('d.review_status', 'in', q.reviewStatus);
    if (q.minConfidence !== undefined) base = base.where('d.confidence', '>=', q.minConfidence);
    if (q.label) base = base.where(sql<boolean>`(lower(d.label) = lower(${q.label}) OR lower(d.corrected_label) = lower(${q.label}))`);
    if (q.jobId) base = base.where('d.job_id', '=', q.jobId);
    const total = await base.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const rows = await base.orderBy('d.frame_time_ms').orderBy('d.confidence', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    await auditResultsViewed(app.db, req, ev, { via: 'detections', filters: { task: q.task, reviewStatus: q.reviewStatus } });
    return { items: rows.map((r) => detectionDto(p, r)), total: total.n, page: q.page, pageSize: q.pageSize };
  });

  app.get('/crops/:detectionId', {
    config: { public: true },
    schema: { tags: ['ai'], summary: 'Detection crop image (media token)', params: z.object({ detectionId: z.string().uuid() }), querystring: z.object({ t: z.string().min(10).max(4096).optional() }) },
  }, async (req, reply) => {
    const { detectionId } = req.params;
    const { claims } = await authenticateMediaToken(app.db, req, req.query.t, { scope: 'image', ref: `ai:${detectionId}` });
    if (claims.typ !== 'USER') throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
    const d = await app.db.selectFrom('ai_detections as d').innerJoin('evidence as e', 'e.id', 'd.evidence_id')
      .select(['d.evidence_id', 'd.crop_key', 'e.status']).where('d.id', '=', detectionId).executeTakeFirst();
    if (!d || d.evidence_id !== claims.eid) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
    if (!d.crop_key || d.status === 'DISPOSED') throw notFound('Crop');
    return sendObject(app.storage, req, reply, { bucket: app.storage.bucket('derived'), key: d.crop_key, contentType: 'image/jpeg' });
  });
}
