/**
 * Reports (spec 17: configurable evidence & compliance reports).
 *   GET  /reports/types                       catalogue + whether the caller may run each type
 *   POST /reports/runs                        request a run (reports:generate + type permission) → QUEUED, REPORT_BUILD
 *   GET  /reports/runs                        my runs
 *   GET  /reports/runs/:id                    my run (others' → 404)
 *   POST /reports/runs/:id/download-link      short-lived tokenised URL (COMPLETED only)
 *   GET  /reports/runs/:id/download?t=…       stream the file (token-authenticated; audited REPORT_DOWNLOADED)
 *
 * Jurisdiction: the run's data scope = org units where the requester holds reports:generate AND every
 * permission the report type requires, frozen into params.scopePaths at request time (optionally narrowed
 * to one org unit inside that scope). Reports never include relationship-based (case/share) visibility.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { QUEUES, REPORT_FORMATS, REPORT_TYPE_CODES, REPORT_TYPES, type Permission, type ReportParams, type ReportType } from '@ksp/shared';
import { appendAudit, enqueue, signMediaToken, verifyMediaToken, type AuditActor } from '@ksp/core';
import { pathCovers, scopePaths, type Principal } from '../../lib/principal.js';
import { conflict, forbidden, notFound, unauthenticated, validationFailed } from '../../lib/errors.js';
import { pageFields } from '../users/admin-lib.js';

export const prefix = '/reports';
export const REPORT_TOKEN_TTL_SECONDS = 300;
const MAX_RANGE_DAYS = 3 * 366;

/** Minimal set of paths where the principal holds ALL of `perms` (intersection of grant scopes). */
export function intersectScopes(p: Principal, perms: Permission[]): string[] {
  let acc = scopePaths(p, perms[0]!);
  for (const perm of perms.slice(1)) {
    const other = scopePaths(p, perm);
    const next = new Set<string>();
    for (const a of acc) for (const b of other) {
      if (pathCovers(a, b)) next.add(b);
      else if (pathCovers(b, a)) next.add(a);
    }
    acc = [...next];
  }
  const sorted = [...new Set(acc)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const x of sorted) if (!out.some((o) => pathCovers(o, x))) out.push(x);
  return out;
}

export function reportScope(p: Principal, type: ReportType): string[] {
  return intersectScopes(p, ['reports:generate', ...(REPORT_TYPES[type].requires as readonly Permission[])]);
}

const createBody = z.object({
  reportType: z.enum(REPORT_TYPE_CODES as [ReportType, ...ReportType[]]),
  format: z.enum(REPORT_FORMATS).default('CSV'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  orgUnitId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  inactiveDays: z.number().int().min(1).max(3650).optional(),
}).strict();
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']).optional(), reportType: z.enum(REPORT_TYPE_CODES as [ReportType, ...ReportType[]]).optional(), ...pageFields });

export default async function reports(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const base = () =>
    db.selectFrom('report_runs as r')
      .leftJoin('org_units as o', 'o.id', 'r.org_unit_id')
      .select(['r.id', 'r.report_type', 'r.format', 'r.status', 'r.params', 'r.row_count', 'r.sha256', 'r.content_sha256', 'r.size_bytes', 'r.error', 'r.created_by', 'r.created_at', 'r.started_at', 'r.finished_at', 'r.download_count', 'o.id as org_id', 'o.name as org_name', 'o.code as org_code']);
  type Row = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;
  const dto = (r: Row) => {
    const params = r.params as unknown as ReportParams;
    return {
      id: r.id, reportType: r.report_type, title: REPORT_TYPES[r.report_type as ReportType]?.title ?? r.report_type, format: r.format, status: r.status,
      params: { from: params.from ?? null, to: params.to ?? null, actorId: params.actorId ?? null, inactiveDays: params.inactiveDays ?? null, jurisdiction: params.scopePaths ?? [] },
      orgUnit: r.org_id ? { id: r.org_id, name: r.org_name, code: r.org_code } : null,
      rowCount: r.row_count, sha256: r.sha256, contentSha256: r.content_sha256, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      error: r.status === 'FAILED' ? r.error : null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, downloadCount: r.download_count,
    };
  };
  const loadOwn = async (p: Principal, id: string) => {
    const r = await base().where('r.id', '=', id).where('r.created_by', '=', p.userId ?? '00000000-0000-0000-0000-000000000000').executeTakeFirst();
    if (!r) throw notFound('Report run');
    return r;
  };

  app.get('/types', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Report catalogue and the caller’s eligibility' },
  }, async (req) => {
    const p = req.requirePrincipal();
    return {
      formats: REPORT_FORMATS,
      items: REPORT_TYPE_CODES.map((code) => {
        const t = REPORT_TYPES[code] as (typeof REPORT_TYPES)[ReportType] & { extraParams?: string[] };
        const scope = reportScope(p, code);
        return { code, title: t.title, description: t.description, requires: t.requires, extraParams: t.extraParams ?? [], available: scope.length > 0, jurisdiction: scope };
      }),
    };
  });

  app.post('/runs', {
    preHandler: app.authorize('reports:generate'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['reports'], summary: 'Request a report run', body: createBody },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw forbidden('Reports require an interactive user');
    const b = req.body;
    const type = REPORT_TYPES[b.reportType];
    const scope = reportScope(p, b.reportType);
    if (!scope.length) {
      await appendAudit(db, req.actor(), { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'report_type', resourceId: b.reportType, details: { missing: type.requires } });
      throw forbidden(`This report requires ${['reports:generate', ...type.requires].join(' + ')} in the same jurisdiction`);
    }
    if (b.from && b.to && b.from >= b.to) throw validationFailed('"from" must be before "to"');
    if (b.from && b.to && b.to.getTime() - b.from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw validationFailed(`The period may not exceed ${MAX_RANGE_DAYS} days`);
    const extra = (type as { extraParams?: readonly string[] }).extraParams ?? [];
    if (b.actorId && !extra.includes('actorId')) throw validationFailed('actorId is not a parameter of this report');
    if (b.inactiveDays && !extra.includes('inactiveDays')) throw validationFailed('inactiveDays is not a parameter of this report');
    let orgUnitId: string | null = null;
    if (b.orgUnitId) {
      const o = await db.selectFrom('org_units').select(['id', 'path']).where('id', '=', b.orgUnitId).executeTakeFirst();
      if (!o || !scope.some((s) => pathCovers(s, o.path))) throw notFound('Org unit');
      orgUnitId = o.id;
    }
    const params: ReportParams = {
      from: b.from?.toISOString() ?? null, to: b.to?.toISOString() ?? null, orgUnitId, actorId: b.actorId ?? null, inactiveDays: b.inactiveDays ?? null,
      scopePaths: scope, requestedBy: { id: p.userId, name: p.displayName, username: p.username },
    };
    const run = await db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('report_runs').values({ report_type: b.reportType, format: b.format, params: JSON.stringify(params), created_by: p.userId!, org_unit_id: orgUnitId }).returning('id').executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'REPORT_REQUESTED', resourceType: 'report_run', resourceId: r.id, orgUnitId,
        details: { reportType: b.reportType, format: b.format, from: params.from, to: params.to, scopePaths: scope, actorId: params.actorId },
      });
      return r;
    });
    await enqueue(QUEUES.REPORT_BUILD, { reportRunId: run.id }, { singletonKey: run.id });
    return reply.status(201).send(dto(await loadOwn(p, run.id)));
  });

  app.get('/runs', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'My report runs', querystring: listQuery },
  }, async (req) => {
    const p = req.requirePrincipal();
    let q = base().where('r.created_by', '=', p.userId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.status) q = q.where('r.status', '=', req.query.status);
    if (req.query.reportType) q = q.where('r.report_type', '=', req.query.reportType);
    const total = await q.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const rows = await q.orderBy('r.created_at', 'desc').offset((req.query.page - 1) * req.query.pageSize).limit(req.query.pageSize).execute();
    return { items: rows.map(dto), total: total.n, page: req.query.page, pageSize: req.query.pageSize };
  });

  app.get('/runs/:id', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Report run status', params: idParam },
  }, async (req) => dto(await loadOwn(req.requirePrincipal(), req.params.id)));

  app.post('/runs/:id/download-link', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Short-lived download URL for a completed report', params: idParam },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadOwn(p, req.params.id);
    if (r.status !== 'COMPLETED') throw conflict('The report is not ready');
    if (!p.userId || !p.sessionId) throw forbidden('Downloads require an interactive user session');
    const token = signMediaToken({ typ: 'USER', sub: p.userId, sid: p.sessionId, eid: r.id, scope: 'download', ref: 'report', ttlSeconds: REPORT_TOKEN_TTL_SECONDS });
    return { url: `/api/v1/reports/runs/${r.id}/download?t=${encodeURIComponent(token)}`, expiresAt: new Date(Date.now() + REPORT_TOKEN_TTL_SECONDS * 1000).toISOString() };
  });

  app.get('/runs/:id/download', {
    config: { public: true },
    schema: { tags: ['reports'], summary: 'Download a report file (token from download-link)', params: idParam, querystring: z.object({ t: z.string().min(10).max(4096) }) },
  }, async (req, reply) => {
    const claims = verifyMediaToken(req.query.t);
    if (!claims || claims.typ !== 'USER' || claims.scope !== 'download' || claims.ref !== 'report' || claims.eid !== req.params.id) throw unauthenticated('Invalid or expired download token');
    const sess = await db.selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id')
      .select(['u.id', 'u.full_name', 'u.status'])
      .where('s.id', '=', claims.sid ?? '00000000-0000-0000-0000-000000000000').where('s.user_id', '=', claims.sub)
      .where('s.revoked_at', 'is', null).where('s.idle_expires_at', '>', new Date()).where('s.absolute_expires_at', '>', new Date()).executeTakeFirst();
    if (!sess || sess.status !== 'ACTIVE') throw unauthenticated('Session is no longer valid');
    const r = await db.selectFrom('report_runs').select(['id', 'status', 'bucket', 'object_key', 'format', 'report_type', 'created_by', 'sha256', 'size_bytes', 'created_at'])
      .where('id', '=', req.params.id).where('created_by', '=', claims.sub).executeTakeFirst();
    if (!r) throw notFound('Report run');
    if (r.status !== 'COMPLETED' || !r.bucket || !r.object_key) throw conflict('The report is not ready');
    const actor: AuditActor = { type: 'USER', id: sess.id, name: sess.full_name, ip: req.ip, userAgent: req.headers['user-agent'] ?? null, sessionId: claims.sid ?? null };
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('report_runs').set((eb) => ({ download_count: eb('download_count', '+', 1) })).where('id', '=', r.id).execute();
      await appendAudit(tx, actor, { action: 'REPORT_DOWNLOADED', resourceType: 'report_run', resourceId: r.id, details: { reportType: r.report_type, format: r.format, sha256: r.sha256 } });
    });
    const obj = await app.storage.get(r.bucket, r.object_key);
    const ext = r.format.toLowerCase();
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    reply
      .header('content-type', r.format === 'CSV' ? 'text/csv; charset=utf-8' : r.format === 'PDF' ? 'application/pdf' : 'application/json')
      .header('content-disposition', `attachment; filename="${r.report_type.toLowerCase()}-${day}-${r.id.slice(0, 8)}.${ext}"`)
      .header('cache-control', 'no-store')
      .header('x-content-sha256', r.sha256 ?? '');
    if (r.size_bytes !== null) reply.header('content-length', String(r.size_bytes));
    return reply.send(obj.Body as NodeJS.ReadableStream);
  });
}
