/**
 * Audit viewer & compliance (spec 13/16).
 *
 *   GET  /audit/events                    filtered, keyset-paginated (by seq, newest first) ledger view   audit:read
 *   GET  /audit/events/:seq               one event incl. hash / prev_hash + row verification              audit:read
 *   POST /audit/export                    CSV / JSON export (streamed to the reports bucket; SHA-256 returned) audit:export
 *   GET  /audit/exports/:id/download      download an audit export (creator only)                         audit:export
 *   POST /audit/verify                    audit_verify() over a range + checkpoint comparison             audit:verify
 *   GET  /audit/checkpoints               signed checkpoints                                             audit:read | audit:verify
 *   POST /audit/checkpoints               cut a checkpoint now (the worker does this hourly)             audit:verify
 *   GET  /audit/checkpoints/:id/verify    signature + chain check of one checkpoint                      audit:verify
 *   GET  /audit/checkpoints/export        all checkpoints + signing certificate (for an external notary)  audit:export
 *
 * Scope: a principal whose audit:read grant is at the state root sees everything; otherwise only events
 * attributed to org units inside their audit:read subtree.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type RawBuilder, type SelectQueryBuilder } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { AUDIT_CATEGORIES, type Permission } from '@ksp/shared';
import { appendAudit, evidenceSigner, type DB } from '@ksp/core';
import { chainBrokenAlert, checkpointPayload, createCheckpoint, mapCheckpoint, sanitizeDetails, verifyCheckpoint, verifyLedger } from '@ksp/core/custody';
import { forbidden, notFound } from '../../lib/errors.js';
import { hasPermission, scopePaths, type Principal } from '../../lib/principal.js';

export const prefix = '/audit';

export const AUDIT_VIEW_THROTTLE_MINUTES = 10;
const MAX_EXPORT_ROWS = 500_000;

const csvList = z.string().max(2000).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const filterSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  actor: z.string().trim().max(200).optional(),
  action: csvList.optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  resourceType: z.string().trim().max(100).optional(),
  resourceId: z.string().trim().max(200).optional(),
  evidenceId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  orgUnitId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
});
type Filters = z.infer<typeof filterSchema>;

/** Rows visible to the principal for `perm`. */
export function auditScopeSql(p: Principal, perm: Permission): RawBuilder<boolean> {
  const paths = scopePaths(p, perm);
  if (!paths.length) return sql<boolean>`false`;
  if (paths.some((x) => !x.includes('.'))) return sql<boolean>`true`;
  return sql<boolean>`e.org_unit_id IN (SELECT ou.id FROM org_units ou WHERE ou.path <@ ${sql.val(paths)}::ltree[])`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters<O>(qb: SelectQueryBuilder<DB & { e: DB['audit_events'] }, 'e' | any, O>, f: Filters) {
  let q = qb;
  if (f.from) q = q.where('e.occurred_at', '>=', f.from);
  if (f.to) q = q.where('e.occurred_at', '<=', f.to);
  if (f.actor) {
    const a = f.actor;
    q = /^[0-9a-f-]{36}$/i.test(a) ? q.where('e.actor_id', '=', a) : q.where((eb) => eb.or([eb('e.actor_name', 'ilike', `%${escapeLike(a)}%`), eb('e.actor_id', '=', a)]));
  }
  if (f.action?.length) q = q.where('e.action', 'in', f.action);
  if (f.category) q = q.where('e.category', '=', f.category);
  if (f.outcome) q = q.where('e.outcome', '=', f.outcome);
  if (f.resourceType) q = q.where('e.resource_type', '=', f.resourceType);
  if (f.resourceId) q = q.where('e.resource_id', '=', f.resourceId);
  if (f.evidenceId) q = q.where('e.evidence_id', '=', f.evidenceId);
  if (f.caseId) q = q.where('e.case_id', '=', f.caseId);
  if (f.orgUnitId) q = q.where('e.org_unit_id', '=', f.orgUnitId);
  if (f.q) q = q.where(sql<boolean>`e.details::text ILIKE ${`%${escapeLike(f.q)}%`}`);
  return q;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const EVENT_COLUMNS = [
  'e.seq', 'e.event_id', 'e.occurred_at', 'e.actor_type', 'e.actor_id', 'e.actor_name', 'e.user_agent', 'e.session_id', 'e.action', 'e.category',
  'e.outcome', 'e.resource_type', 'e.resource_id', 'e.evidence_id', 'e.case_id', 'e.org_unit_id', 'e.details', 'e.prev_hash', 'e.hash',
] as const;

type EventRow = {
  seq: number; event_id: string; occurred_at: Date; actor_type: string; actor_id: string | null; actor_name: string | null; actor_ip: string | null;
  user_agent: string | null; session_id: string | null; action: string; category: string; outcome: string; resource_type: string | null; resource_id: string | null;
  evidence_id: string | null; case_id: string | null; org_unit_id: string | null; details: unknown; prev_hash: string; hash: string;
};

export function eventDto(r: EventRow) {
  return {
    seq: Number(r.seq),
    eventId: r.event_id,
    occurredAt: r.occurred_at.toISOString(),
    actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name, ip: r.actor_ip, userAgent: r.user_agent, sessionId: r.session_id },
    action: r.action,
    category: r.category,
    outcome: r.outcome,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    evidenceId: r.evidence_id,
    caseId: r.case_id,
    orgUnitId: r.org_unit_id,
    details: sanitizeDetails(r.details),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Neutralise spreadsheet formula injection (OWASP CSV injection) and quote. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_HEADER = ['seq', 'event_id', 'occurred_at', 'actor_type', 'actor_id', 'actor_name', 'actor_ip', 'action', 'category', 'outcome', 'resource_type', 'resource_id', 'evidence_id', 'case_id', 'org_unit_id', 'details', 'prev_hash', 'hash'];

export default async function audit(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const anyOf = (...perms: Permission[]) => async (req: import('fastify').FastifyRequest) => {
    const p = req.requirePrincipal();
    if (!perms.some((x) => hasPermission(p, x))) {
      await appendAudit(app.db, req.actor(), { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'route', resourceId: `${req.method} ${req.routeOptions.url}`, details: { missingAnyOf: perms } });
      throw forbidden();
    }
  };

  const baseQuery = (p: Principal, perm: Permission) =>
    app.db.selectFrom('audit_events as e').select([...EVENT_COLUMNS, sql<string | null>`host(e.actor_ip)`.as('actor_ip')]).where(auditScopeSql(p, perm));

  async function auditViewed(req: import('fastify').FastifyRequest, details: Record<string, unknown>) {
    const p = req.requirePrincipal();
    const recent = await app.db
      .selectFrom('audit_events')
      .select('seq')
      .where('action', '=', 'AUDIT_VIEWED')
      .where('actor_id', '=', p.userId ?? p.apiClientId ?? '')
      .where('occurred_at', '>', sql<Date>`now() - make_interval(mins => ${AUDIT_VIEW_THROTTLE_MINUTES})`)
      .limit(1)
      .executeTakeFirst();
    if (!recent) await appendAudit(app.db, req.actor(), { action: 'AUDIT_VIEWED', resourceType: 'audit_events', details: { ...details, throttleMinutes: AUDIT_VIEW_THROTTLE_MINUTES } });
  }

  // ---------------------------------------------------------------------------------------------
  app.get('/events', {
    preHandler: app.authorize('audit:read'),
    schema: {
      tags: ['audit'], summary: 'Audit ledger events (keyset pagination by seq, newest first)',
      querystring: filterSchema.extend({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const { before, limit, ...f } = req.query;
    let q = applyFilters(baseQuery(p, 'audit:read'), f);
    if (before) q = q.where('e.seq', '<', before);
    const rows = (await q.orderBy('e.seq', 'desc').limit(limit + 1).execute()) as unknown as EventRow[];
    const page = rows.slice(0, limit);
    await auditViewed(req, { filters: { ...f, from: f.from?.toISOString(), to: f.to?.toISOString() } });
    return { items: page.map(eventDto), nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null, limit };
  });

  app.get('/events/:seq', {
    preHandler: app.authorize('audit:read'),
    schema: { tags: ['audit'], summary: 'One audit event with row verification', params: z.object({ seq: z.coerce.number().int().positive() }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const row = (await baseQuery(p, 'audit:read')
      .select([
        sql<boolean>`e.hash = encode(digest(e.prev_hash || '|' || audit_canonical(e), 'sha256'), 'hex')`.as('hash_ok'),
        sql<boolean>`(e.prev_hash = CASE WHEN e.seq = 1 THEN repeat('0', 64) ELSE (SELECT pe.hash FROM audit_events pe WHERE pe.seq = e.seq - 1) END) IS TRUE`.as('link_ok'),
      ])
      .where('e.seq', '=', req.params.seq)
      .executeTakeFirst()) as unknown as (EventRow & { hash_ok: boolean; link_ok: boolean }) | undefined;
    if (!row) throw notFound('Audit event');
    await auditViewed(req, { seq: req.params.seq });
    return { ...eventDto(row), verification: { hashOk: row.hash_ok, linkOk: row.link_ok, verified: row.hash_ok && row.link_ok } };
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/export', {
    preHandler: app.authorize('audit:export'),
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['audit'], summary: 'Export audit events as CSV or JSON (stored; SHA-256 of the file returned)',
      body: z.object({ format: z.enum(['csv', 'json']).default('csv'), filters: filterSchema.default({}) }),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const { format, filters } = req.body;
    const id = randomUUID();
    const bucket = app.storage.bucket('reports');
    const key = `audit-exports/${new Date().toISOString().slice(0, 7)}/${id}.${format}`;
    const hash = createHash('sha256');
    let size = 0;
    const out = new PassThrough();
    const upload = app.storage.put(bucket, key, out, { contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json' });
    const write = async (s: string) => {
      const b = Buffer.from(s, 'utf8');
      hash.update(b);
      size += b.length;
      if (!out.write(b)) await once(out, 'drain');
    };
    let rows = 0;
    let before: number | null = null;
    try {
      if (format === 'csv') await write(`${CSV_HEADER.join(',')}\n`);
      else await write(`{"type":"KSP-AUDIT-EXPORT","exportedAt":${JSON.stringify(new Date().toISOString())},"exportedBy":${JSON.stringify(p.username)},"filters":${JSON.stringify(filters)},"events":[`);
      for (;;) {
        let q = applyFilters(baseQuery(p, 'audit:export'), filters);
        if (before !== null) q = q.where('e.seq', '<', before);
        const batch = (await q.orderBy('e.seq', 'desc').limit(2000).execute()) as unknown as EventRow[];
        for (const r of batch) {
          if (format === 'csv') {
            await write(`${[r.seq, r.event_id, r.occurred_at.toISOString(), r.actor_type, r.actor_id, r.actor_name, r.actor_ip, r.action, r.category, r.outcome, r.resource_type, r.resource_id, r.evidence_id, r.case_id, r.org_unit_id, sanitizeDetails(r.details), r.prev_hash, r.hash].map(csvCell).join(',')}\n`);
          } else {
            await write(`${rows ? ',' : ''}${JSON.stringify(eventDto(r))}`);
          }
          rows++;
        }
        if (batch.length < 2000 || rows >= MAX_EXPORT_ROWS) break;
        before = Number(batch[batch.length - 1]!.seq);
      }
      if (format === 'json') await write(`],"rowCount":${rows}}\n`);
      out.end();
      await upload;
    } catch (err) {
      out.destroy(err as Error);
      await upload.catch(() => undefined);
      throw err;
    }
    const sha256 = hash.digest('hex');
    await app.db.transaction().execute(async (tx) => {
      await tx.insertInto('report_runs').values({
        id, report_type: 'AUDIT_EXPORT', params: JSON.stringify({ filters }), format: format.toUpperCase(), status: 'COMPLETED', row_count: rows,
        bucket, object_key: key, sha256, created_by: p.userId!, finished_at: new Date(),
      }).execute();
      await appendAudit(tx, req.actor(), { action: 'AUDIT_EXPORTED', resourceType: 'report_run', resourceId: id, details: { format, rowCount: rows, sha256, sizeBytes: size, truncated: rows >= MAX_EXPORT_ROWS, filters } });
    });
    return reply.status(201).send({ id, format, rowCount: rows, sizeBytes: size, sha256, truncated: rows >= MAX_EXPORT_ROWS, downloadUrl: `/api/v1/audit/exports/${id}/download` });
  });

  app.get('/exports/:id/download', {
    preHandler: app.authorize('audit:export'),
    schema: { tags: ['audit'], summary: 'Download an audit export you created', params: z.object({ id: z.string().uuid() }) },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const r = await app.db.selectFrom('report_runs').selectAll().where('id', '=', req.params.id).where('report_type', '=', 'AUDIT_EXPORT').executeTakeFirst();
    if (!r || r.created_by !== p.userId || !r.bucket || !r.object_key) throw notFound('Audit export');
    const obj = await app.storage.get(r.bucket, r.object_key);
    return reply
      .header('Content-Type', r.format === 'CSV' ? 'text/csv; charset=utf-8' : 'application/json')
      .header('Content-Disposition', `attachment; filename="audit_${r.id.slice(0, 8)}.${r.format.toLowerCase()}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-SHA256', r.sha256 ?? '')
      .send(obj.Body);
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/verify', {
    preHandler: app.authorize('audit:verify'),
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10_000 : 6, timeWindow: '1 minute' } },
    schema: { tags: ['audit'], summary: 'Recompute the ledger hash chain and compare with signed checkpoints', body: z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional() }).default({}) },
  }, async (req) => {
    const from = req.body?.from ?? 1;
    const to = req.body?.to ?? null;
    const started = Date.now();
    const result = await verifyLedger(app.db, from, to);
    const head = result.headSeq ?? 0;
    const cps = await app.db.selectFrom('audit_checkpoints').selectAll().where('head_seq', '>=', from).where('head_seq', '<=', to ?? head).orderBy('head_seq', 'desc').limit(50).execute();
    const signer = evidenceSigner();
    const checkpoints = [];
    for (const raw of cps) {
      const c = mapCheckpoint(raw as never);
      let signatureValid = false;
      try {
        signatureValid = signer.verify(Buffer.from(checkpointPayload({ headSeq: c.headSeq, headHash: c.headHash, createdAt: new Date(c.createdAt), keyId: c.keyId }), 'utf8'), c.signature);
      } catch {
        signatureValid = false;
      }
      const at = await app.db.selectFrom('audit_events').select('hash').where('seq', '=', c.headSeq).executeTakeFirst();
      checkpoints.push({ id: c.id, headSeq: c.headSeq, createdAt: c.createdAt, keyId: c.keyId, signatureValid, headMatches: !!at && at.hash === c.headHash, withinVerifiedRange: result.ok || c.headSeq < (result.firstBadSeq ?? Infinity) });
    }
    const checkpointsOk = checkpoints.every((c) => c.signatureValid && c.headMatches);
    const ok = result.ok && checkpointsOk;
    if (!result.ok) await chainBrokenAlert(app.db, result.firstBadSeq!, `requested by ${req.requirePrincipal().username}`);
    await appendAudit(app.db, req.actor(), { action: 'AUDIT_VERIFIED', outcome: ok ? 'SUCCESS' : 'FAILURE', resourceType: 'audit_ledger', details: { from, to, checked: result.checked, firstBadSeq: result.firstBadSeq, headSeq: result.headSeq, checkpointsChecked: checkpoints.length, checkpointsOk } });
    return { ok, chainOk: result.ok, checkpointsOk, from, to, checked: result.checked, firstBadSeq: result.firstBadSeq, headSeq: result.headSeq, headHash: result.headHash, checkpoints, verifiedAt: new Date().toISOString(), durationMs: Date.now() - started };
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/checkpoints', {
    preHandler: anyOf('audit:read', 'audit:verify'),
    schema: { tags: ['audit'], summary: 'Signed ledger checkpoints (newest first)', querystring: z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  }, async (req) => {
    let q = app.db.selectFrom('audit_checkpoints').selectAll();
    if (req.query.before) q = q.where('id', '<', req.query.before);
    const rows = await q.orderBy('id', 'desc').limit(req.query.limit + 1).execute();
    const page = rows.slice(0, req.query.limit).map((r) => mapCheckpoint(r as never));
    const head = await app.db.selectFrom('audit_events').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    return { items: page, nextCursor: rows.length > req.query.limit ? String(page[page.length - 1]!.id) : null, ledgerHead: head ? { seq: Number(head.seq), hash: head.hash } : null };
  });

  app.post('/checkpoints', {
    preHandler: app.authorize('audit:verify'),
    schema: { tags: ['audit'], summary: 'Verify since the last checkpoint and sign the current ledger head now' },
  }, async (req, reply) => {
    const r = await createCheckpoint(app.db, req.actor());
    return reply.status(r.created ? 201 : 200).send(r);
  });

  app.get('/checkpoints/export', {
    preHandler: app.authorize('audit:export'),
    schema: { tags: ['audit'], summary: 'All checkpoints with their signed payloads and the signing certificate (for external notarisation)' },
  }, async (req, reply) => {
    const rows = await app.db.selectFrom('audit_checkpoints').selectAll().orderBy('id').execute();
    const probe = await evidenceSigner().sign(Buffer.from('certificate'));
    const body = {
      type: 'KSP-AUDIT-CHECKPOINTS',
      exportedAt: new Date().toISOString(),
      signingCertificate: probe.certificatePem,
      certificateFingerprint256: probe.certificateFingerprint256,
      checkpoints: rows.map((r) => {
        const c = mapCheckpoint(r as never);
        return { ...c, payload: checkpointPayload({ headSeq: c.headSeq, headHash: c.headHash, createdAt: new Date(c.createdAt), keyId: c.keyId }) };
      }),
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    await appendAudit(app.db, req.actor(), { action: 'AUDIT_EXPORTED', resourceType: 'audit_checkpoints', details: { checkpoints: rows.length, sha256: createHash('sha256').update(text).digest('hex') } });
    return reply.header('Content-Type', 'application/json').header('Content-Disposition', 'attachment; filename="audit_checkpoints.json"').send(text);
  });

  app.get('/checkpoints/:id/verify', {
    preHandler: app.authorize('audit:verify'),
    schema: { tags: ['audit'], summary: 'Verify one checkpoint: signature, head hash and chain since the previous checkpoint', params: z.object({ id: z.coerce.number().int().positive() }) },
  }, async (req) => {
    const r = await verifyCheckpoint(app.db, req.params.id);
    if (!r) throw notFound('Checkpoint');
    if (!r.chain.ok && r.chain.firstBadSeq) await chainBrokenAlert(app.db, r.chain.firstBadSeq, `checkpoint ${r.checkpoint.id} verification`);
    await appendAudit(app.db, req.actor(), { action: 'AUDIT_VERIFIED', outcome: r.ok ? 'SUCCESS' : 'FAILURE', resourceType: 'audit_checkpoint', resourceId: String(r.checkpoint.id), details: { signatureValid: r.signatureValid, headMatches: r.headMatches, chainOk: r.chain.ok, firstBadSeq: r.chain.firstBadSeq } });
    return r;
  });
}
