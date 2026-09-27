/**
 * Evidence registry (spec module 4): list, detail, descriptive metadata, tags, processing jobs.
 * Lifecycle (legal hold, integrity, retention, tiers, disposal) lives in ./lifecycle-routes.ts under the same prefix.
 * Every read goes through evidenceVisibleSql / loadEvidenceFor; storage bucket/key/version are never returned.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit } from '@ksp/core';
import { EVIDENCE_STATUSES, MEDIA_STATUSES, STORAGE_TIERS } from '@ksp/shared';
import { loadEvidenceFor } from '../../lib/access.js';
import { recordInternalShareOpen } from '../../lib/share-views.js';
import { hasPermission } from '../../lib/principal.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { LIST_SORTS, listEvidence, loadDetail } from './queries.js';
import { evidencePermissions } from './perms.js';
import lifecycleRoutes from './lifecycle-routes.js';

export const prefix = '/evidence';

const TAG_RE = /^[a-z0-9][a-z0-9 _:.-]{0,62}$/;
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) if (!(values as readonly string[]).includes(p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid value ${p}` });
      return parts;
    });
const bool = z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true'));
const sortValues = LIST_SORTS.flatMap((s) => [s, `-${s}`]) as [string, ...string[]];

export const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: csv(EVIDENCE_STATUSES),
  mediaStatus: csv(MEDIA_STATUSES),
  storageTier: csv(STORAGE_TIERS),
  orgUnitId: z.string().uuid().optional(),
  officerId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  uploadedBy: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  category: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(63).optional(),
  recordedFrom: z.coerce.date().optional(),
  recordedTo: z.coerce.date().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  legalHold: bool,
  hasGps: bool,
  sort: z.enum(sortValues).default('-created_at'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const patchBody = z
  .object({
    title: z.string().trim().max(300).nullable(),
    description: z.string().trim().max(10_000).nullable(),
    category: z.string().trim().max(100).nullable(),
    incidentAt: z.coerce.date().nullable(),
    locationText: z.string().trim().max(500).nullable(),
  })
  .partial()
  .strict();

const EDITABLE: Record<keyof z.infer<typeof patchBody>, 'title' | 'description' | 'category' | 'incident_at' | 'location_text'> = {
  title: 'title',
  description: 'description',
  category: 'category',
  incidentAt: 'incident_at',
  locationText: 'location_text',
};

/** Strip anything storage-location-like from job results before returning them to clients. */
export function sanitizeResult(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeResult);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!/bucket|key|version_?id|url/i.test(k)) out[k] = sanitizeResult(x);
    return out;
  }
  return v;
}

export const FINAL_STATUSES = ['DISPOSED', 'REJECTED'];

export default async function evidence(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/', { schema: { tags: ['evidence'], summary: 'List evidence visible to the caller', querystring: listQuery } }, async (req) => {
    const p = req.requirePrincipal();
    if (!['evidence:read', 'evidence:read_own', 'cases:read', 'search:use'].some((perm) => hasPermission(p, perm as never))) throw forbidden();
    const { sort, page, pageSize, ...filters } = req.query;
    return listEvidence(app.db, p, filters, sort, page, pageSize);
  });

  await app.register(lifecycleRoutes);

  app.get('/:id', { schema: { tags: ['evidence'], summary: 'Evidence detail (records an EVIDENCE_VIEWED custody event)', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
    await recordInternalShareOpen(app.db, p, ev, req.actor(), { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, via: 'detail' });
    const { row, body } = await loadDetail(app.db, p, ev.id);
    const permissions = await evidencePermissions(app.db, p, { id: row.id, org_path: row.org_path, status: row.status, legal_hold: row.legal_hold });
    await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_VIEWED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id });
    return { ...body, permissions };
  });

  app.patch('/:id', { schema: { tags: ['evidence'], summary: 'Edit descriptive metadata (title, description, category, incident time, location)', params: idParams, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:edit_metadata', req.actor());
    if (FINAL_STATUSES.includes(ev.status)) throw conflict(`Evidence is ${ev.status.toLowerCase()} and can no longer be edited`);
    const entries = Object.entries(req.body) as Array<[keyof typeof EDITABLE, unknown]>;
    if (!entries.length) throw validationFailed('No editable fields supplied');
    await app.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('evidence').select(['title', 'description', 'category', 'incident_at', 'location_text']).where('id', '=', ev.id).forUpdate().executeTakeFirstOrThrow();
      const set: Record<string, unknown> = {};
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const [k, v] of entries) {
        const col = EDITABLE[k];
        const value = typeof v === 'string' && v === '' ? null : v;
        const prev = before[col];
        const same = prev instanceof Date && value instanceof Date ? prev.getTime() === value.getTime() : prev === value;
        if (same) continue;
        set[col] = value;
        changes[k] = { before: prev, after: value };
      }
      if (!Object.keys(set).length) return;
      await tx.updateTable('evidence').set(set).where('id', '=', ev.id).execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_METADATA_UPDATED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { changes } });
    });
    const { row, body } = await loadDetail(app.db, p, ev.id);
    const permissions = await evidencePermissions(app.db, p, { id: row.id, org_path: row.org_path, status: row.status, legal_hold: row.legal_hold });
    return { ...body, permissions };
  });

  app.post('/:id/tags', { schema: { tags: ['evidence'], summary: 'Add a manual tag', params: idParams, body: z.object({ tag: z.string().trim().min(1).max(63) }).strict() } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:edit_metadata', req.actor());
    if (FINAL_STATUSES.includes(ev.status)) throw conflict(`Evidence is ${ev.status.toLowerCase()} and can no longer be tagged`);
    const tag = req.body.tag.toLowerCase().replace(/\s+/g, ' ');
    if (!TAG_RE.test(tag)) throw validationFailed('Tags must start with a letter or digit and contain only a-z, 0-9, space, _ : . - (max 63)');
    const created = await app.db.transaction().execute(async (tx) => {
      const ins = await tx.insertInto('evidence_tags').values({ evidence_id: ev.id, tag, source: 'MANUAL', created_by: p.userId }).onConflict((oc) => oc.doNothing()).returning('tag').executeTakeFirst();
      if (!ins) return false;
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_TAGGED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { added: tag } });
      return true;
    });
    const tags = await app.db.selectFrom('evidence_tags').select(['tag', 'source']).where('evidence_id', '=', ev.id).orderBy('tag').execute();
    return reply.status(created ? 201 : 200).send({ tags });
  });

  app.delete('/:id/tags/:tag', { schema: { tags: ['evidence'], summary: 'Remove a manual tag', params: z.object({ id: z.string().uuid(), tag: z.string().min(1).max(63) }) } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:edit_metadata', req.actor());
    if (FINAL_STATUSES.includes(ev.status)) throw conflict(`Evidence is ${ev.status.toLowerCase()} and can no longer be edited`);
    const tag = req.params.tag.toLowerCase();
    await app.db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('evidence_tags').select('source').where('evidence_id', '=', ev.id).where('tag', '=', tag).executeTakeFirst();
      if (!existing) throw notFound('Tag');
      if (existing.source !== 'MANUAL') throw conflict('Only manual tags can be removed here; AI/integration tags are managed through review');
      await tx.deleteFrom('evidence_tags').where('evidence_id', '=', ev.id).where('tag', '=', tag).execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_TAGGED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { removed: tag } });
    });
    const tags = await app.db.selectFrom('evidence_tags').select(['tag', 'source']).where('evidence_id', '=', ev.id).orderBy('tag').execute();
    return { tags };
  });

  app.get('/:id/jobs', { schema: { tags: ['evidence'], summary: 'Background processing jobs for this evidence', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
    const rows = await app.db
      .selectFrom('processing_jobs')
      .select(['id', 'kind', 'status', 'progress', 'attempts', 'error', 'result', 'created_at', 'started_at', 'finished_at'])
      .where('evidence_id', '=', ev.id)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return {
      items: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, progress: r.progress, attempts: r.attempts, error: r.error, result: sanitizeResult(r.result), createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at })),
    };
  });
}
