/**
 * Reports (spec 17: configurable evidence & compliance reports).
 *   GET  /reports/types                       catalogue + whether the caller may run each type
 *   POST /reports/runs                        request a run (reports:generate + type permission) → QUEUED, REPORT_BUILD
 *   GET  /reports/runs                        my runs
 *   GET  /reports/runs/:id                    my run (others' → 404)
 *   POST /reports/runs/:id/download-link      short-lived tokenised URL (COMPLETED only)
 *   GET  /reports/runs/:id/download?t=…       stream the file (token-authenticated; audited REPORT_DOWNLOADED)
 *   GET  /reports/runs?shared=true            runs of schedules that list me as a recipient
 *   GET|POST /reports/schedules               my scheduled reports / create one (reports:generate + type permission)
 *   PATCH|DELETE /reports/schedules/:id       owner only (others → 404); audited REPORT_SCHEDULE_*
 *
 * Scheduled runs (reports.schedule cron, apps/worker/src/jobs/reports/schedule.ts) are created_by the owner with
 * the owner's jurisdiction computed at RUN time. Recipients are frozen into report_runs.recipient_ids at run time
 * (only recipients whose own report jurisdiction covers the run's scope); a recipient may view/download such a
 * run only while that still holds (re-checked on every access).
 *
 * Jurisdiction: the run's data scope = org units where the requester holds reports:generate AND every
 * permission the report type requires, frozen into params.scopePaths at request time (optionally narrowed
 * to one org unit inside that scope). Reports never include relationship-based (case/share) visibility.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import {
  DEFAULT_LOOKBACK_DAYS, QUEUES, REPORT_FORMATS, REPORT_FREQUENCIES, REPORT_TYPE_CODES, REPORT_TYPES, reportScopeFromGrants, scheduleCron, scopeCovered,
  type Permission, type ReportParams, type ReportScheduleTiming, type ReportType,
} from '@ksp/shared';
import { appendAudit, enqueue, minCronIntervalSeconds, nextCronRun, signMediaToken, validateCron, verifyMediaToken, type AuditActor } from '@ksp/core';
import { loadGrants } from '../../lib/load-principal.js';
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
const listQuery = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']).optional(), reportType: z.enum(REPORT_TYPE_CODES as [ReportType, ...ReportType[]]).optional(),
  shared: z.enum(['true', 'false']).optional().transform((v) => v === 'true'), scheduleId: z.string().uuid().optional(), ...pageFields,
});

const scheduleFields = {
  name: z.string().trim().min(1).max(200),
  reportType: z.enum(REPORT_TYPE_CODES as [ReportType, ...ReportType[]]),
  format: z.enum(REPORT_FORMATS),
  frequency: z.enum(REPORT_FREQUENCIES),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  cron: z.string().trim().min(9).max(120),
  timezone: z.string().trim().min(1).max(64),
  lookbackDays: z.number().int().min(1).max(MAX_RANGE_DAYS),
  orgUnitId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  inactiveDays: z.number().int().min(1).max(3650).nullable(),
  recipientIds: z.array(z.string().uuid()).max(50),
  emailRecipients: z.boolean(),
  enabled: z.boolean(),
};
const scheduleCreate = z.object(scheduleFields).partial().required({ name: true, reportType: true, frequency: true }).strict();
const schedulePatch = z.object(scheduleFields).partial().strict();
type ScheduleInput = z.infer<typeof scheduleCreate>;
/** Schedules may not fire more often than hourly. */
const MIN_SCHEDULE_INTERVAL_SECONDS = 3600;

interface ScheduleParamsJson { orgUnitId?: string | null; actorId?: string | null; inactiveDays?: number | null; timing?: Omit<ReportScheduleTiming, 'frequency'> }

export default async function reports(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const base = () =>
    db.selectFrom('report_runs as r')
      .leftJoin('org_units as o', 'o.id', 'r.org_unit_id')
      .select(['r.id', 'r.report_type', 'r.format', 'r.status', 'r.params', 'r.row_count', 'r.sha256', 'r.content_sha256', 'r.size_bytes', 'r.error', 'r.created_by', 'r.created_at', 'r.started_at', 'r.finished_at', 'r.download_count', 'r.schedule_id', 'r.scheduled_for', 'o.id as org_id', 'o.name as org_name', 'o.code as org_code']);
  type Row = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;
  const dto = (r: Row) => {
    const params = r.params as unknown as ReportParams;
    return {
      id: r.id, reportType: r.report_type, title: REPORT_TYPES[r.report_type as ReportType]?.title ?? r.report_type, format: r.format, status: r.status,
      params: { from: params.from ?? null, to: params.to ?? null, actorId: params.actorId ?? null, inactiveDays: params.inactiveDays ?? null, jurisdiction: params.scopePaths ?? [] },
      orgUnit: r.org_id ? { id: r.org_id, name: r.org_name, code: r.org_code } : null,
      rowCount: r.row_count, sha256: r.sha256, contentSha256: r.content_sha256, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      error: r.status === 'FAILED' ? r.error : null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, downloadCount: r.download_count,
      scheduleId: r.schedule_id, scheduledFor: r.scheduled_for, requestedBy: params.requestedBy ? { id: params.requestedBy.id, name: params.requestedBy.name } : null,
    };
  };
  const NIL = '00000000-0000-0000-0000-000000000000';
  const loadOwn = async (p: Principal, id: string) => {
    const r = await base().where('r.id', '=', id).where('r.created_by', '=', p.userId ?? NIL).executeTakeFirst();
    if (!r) throw notFound('Report run');
    return r;
  };
  /** Own run, or a scheduled run that lists the user as recipient AND is still inside the user's own report jurisdiction. */
  const recipientMayAccess = async (userId: string, run: { report_type: string; params: unknown }) => {
    const scope = (run.params as ReportParams).scopePaths ?? [];
    const mine = reportScopeFromGrants(await loadGrants(db, userId), run.report_type as ReportType);
    return scope.length > 0 && scopeCovered(scope, mine);
  };
  const loadAccessible = async (p: Principal, id: string) => {
    const uid = p.userId ?? NIL;
    const r = await base().select('r.recipient_ids').where('r.id', '=', id)
      .where((eb) => eb.or([eb('r.created_by', '=', uid), sql<boolean>`${uid}::uuid = ANY (r.recipient_ids)`])).executeTakeFirst();
    if (!r) throw notFound('Report run');
    if (r.created_by !== uid && !(await recipientMayAccess(uid, r))) throw notFound('Report run');
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
    const uid = p.userId ?? NIL;
    let q = req.query.shared
      ? base().where(sql<boolean>`${uid}::uuid = ANY (r.recipient_ids)`).where('r.created_by', '<>', uid)
      : base().where('r.created_by', '=', uid);
    if (req.query.scheduleId) q = q.where('r.schedule_id', '=', req.query.scheduleId);
    if (req.query.status) q = q.where('r.status', '=', req.query.status);
    if (req.query.reportType) q = q.where('r.report_type', '=', req.query.reportType);
    const total = await q.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    let rows = await q.orderBy('r.created_at', 'desc').offset((req.query.page - 1) * req.query.pageSize).limit(req.query.pageSize).execute();
    if (req.query.shared) {
      // Hide runs whose scope the recipient no longer covers (grant revoked since the run).
      const mine = new Map<string, string[]>();
      const grants = await loadGrants(db, uid);
      rows = rows.filter((r) => {
        if (!mine.has(r.report_type)) mine.set(r.report_type, reportScopeFromGrants(grants, r.report_type as ReportType));
        const scope = (r.params as unknown as ReportParams).scopePaths ?? [];
        return scope.length > 0 && scopeCovered(scope, mine.get(r.report_type)!);
      });
    }
    return { items: rows.map(dto), total: total.n, page: req.query.page, pageSize: req.query.pageSize };
  });

  app.get('/runs/:id', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Report run status', params: idParam },
  }, async (req) => dto(await loadAccessible(req.requirePrincipal(), req.params.id)));

  app.post('/runs/:id/download-link', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Short-lived download URL for a completed report', params: idParam },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadAccessible(p, req.params.id);
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
    const r = await db.selectFrom('report_runs').select(['id', 'status', 'bucket', 'object_key', 'format', 'report_type', 'created_by', 'sha256', 'size_bytes', 'created_at', 'params', 'schedule_id'])
      .where('id', '=', req.params.id).where((eb) => eb.or([eb('created_by', '=', claims.sub), sql<boolean>`${claims.sub}::uuid = ANY (recipient_ids)`])).executeTakeFirst();
    if (!r) throw notFound('Report run');
    if (r.created_by !== claims.sub && !(await recipientMayAccess(claims.sub, r))) throw notFound('Report run');
    if (r.status !== 'COMPLETED' || !r.bucket || !r.object_key) throw conflict('The report is not ready');
    const actor: AuditActor = { type: 'USER', id: sess.id, name: sess.full_name, ip: req.ip, userAgent: req.headers['user-agent'] ?? null, sessionId: claims.sid ?? null };
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('report_runs').set((eb) => ({ download_count: eb('download_count', '+', 1) })).where('id', '=', r.id).execute();
      await appendAudit(tx, actor, { action: 'REPORT_DOWNLOADED', resourceType: 'report_run', resourceId: r.id, details: { reportType: r.report_type, format: r.format, sha256: r.sha256, ...(r.created_by !== claims.sub ? { asScheduleRecipient: true, scheduleId: r.schedule_id } : {}) } });
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
  // ---- scheduled reports -------------------------------------------------------------------------
  const schedBase = () => db.selectFrom('report_schedules as s').selectAll('s');
  type SRow = Awaited<ReturnType<ReturnType<typeof schedBase>['executeTakeFirstOrThrow']>>;
  const schedDto = async (rows: SRow[]) => {
    const ids = [...new Set(rows.flatMap((r) => r.recipient_ids))];
    const users = ids.length ? await db.selectFrom('users').select(['id', 'full_name', 'username']).where('id', 'in', ids).execute() : [];
    const orgIds = [...new Set(rows.map((r) => (r.params as ScheduleParamsJson).orgUnitId).filter((x): x is string => !!x))];
    const orgs = orgIds.length ? await db.selectFrom('org_units').select(['id', 'name', 'code']).where('id', 'in', orgIds).execute() : [];
    return rows.map((r) => {
      const prm = r.params as ScheduleParamsJson;
      return {
        id: r.id, name: r.name, reportType: r.report_type, title: REPORT_TYPES[r.report_type as ReportType]?.title ?? r.report_type, format: r.format,
        frequency: r.frequency, cron: r.cron, timezone: r.timezone, lookbackDays: r.lookback_days, ...(prm.timing ?? {}),
        orgUnit: prm.orgUnitId ? orgs.find((o) => o.id === prm.orgUnitId) ?? { id: prm.orgUnitId, name: null, code: null } : null,
        actorId: prm.actorId ?? null, inactiveDays: prm.inactiveDays ?? null,
        recipients: r.recipient_ids.map((id) => { const u = users.find((x) => x.id === id); return { id, fullName: u?.full_name ?? null, username: u?.username ?? null }; }),
        emailRecipients: r.email_recipients, enabled: r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastRunId: r.last_run_id, lastError: r.last_error,
        createdAt: r.created_at, updatedAt: r.updated_at,
      };
    });
  };
  const loadOwnSchedule = async (p: Principal, id: string) => {
    const r = await schedBase().where('s.id', '=', id).where('s.owner_id', '=', p.userId ?? NIL).executeTakeFirst();
    if (!r) throw notFound('Report schedule');
    return r;
  };

  /** Validate a complete schedule definition for its owner; returns the DB column values. */
  const validateSchedule = async (p: Principal, b: ScheduleInput, actor: AuditActor) => {
    const type = REPORT_TYPES[b.reportType];
    const scope = reportScope(p, b.reportType);
    if (!scope.length) {
      await appendAudit(db, actor, { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'report_type', resourceId: b.reportType, details: { missing: type.requires, schedule: true } });
      throw forbidden(`This report requires ${['reports:generate', ...type.requires].join(' + ')} in the same jurisdiction`);
    }
    const extra = (type as { extraParams?: readonly string[] }).extraParams ?? [];
    if (b.actorId && !extra.includes('actorId')) throw validationFailed('actorId is not a parameter of this report');
    if (b.inactiveDays && !extra.includes('inactiveDays')) throw validationFailed('inactiveDays is not a parameter of this report');
    const timezone = b.timezone ?? 'Asia/Kolkata';
    const timing: ReportScheduleTiming = { frequency: b.frequency, hour: b.hour, minute: b.minute, dayOfWeek: b.dayOfWeek, dayOfMonth: b.dayOfMonth, cron: b.cron };
    if (b.frequency === 'CRON' && !b.cron) throw validationFailed('cron is required for frequency CRON');
    const cron = scheduleCron(timing);
    try {
      validateCron(cron, timezone);
    } catch (e) {
      throw validationFailed(`Invalid schedule: ${(e as Error).message}`);
    }
    if (minCronIntervalSeconds(cron, timezone) < MIN_SCHEDULE_INTERVAL_SECONDS) throw validationFailed('Scheduled reports may run at most once per hour');
    let runScope = scope;
    let orgUnitId: string | null = null;
    if (b.orgUnitId) {
      const o = await db.selectFrom('org_units').select(['id', 'path']).where('id', '=', b.orgUnitId).executeTakeFirst();
      if (!o || !scope.some((s) => pathCovers(s, o.path))) throw notFound('Org unit');
      orgUnitId = o.id;
      runScope = [o.path];
    }
    const recipientIds = [...new Set(b.recipientIds ?? [])].filter((id) => id !== p.userId);
    if (recipientIds.length) {
      const users = await db.selectFrom('users').select(['id', 'full_name', 'status']).where('id', 'in', recipientIds).execute();
      const bad: string[] = [];
      for (const id of recipientIds) {
        const u = users.find((x) => x.id === id);
        if (!u || u.status !== 'ACTIVE') { bad.push(id); continue; }
        if (!scopeCovered(runScope, reportScopeFromGrants(await loadGrants(db, id), b.reportType))) bad.push(u.full_name);
      }
      if (bad.length) throw validationFailed(`Recipients must be active users who may run this report over the whole scope themselves: ${bad.join(', ')}`, { recipients: bad });
    }
    const params: ScheduleParamsJson = {
      orgUnitId, actorId: b.actorId ?? null, inactiveDays: b.inactiveDays ?? null,
      timing: { hour: b.hour, minute: b.minute, dayOfWeek: b.dayOfWeek, dayOfMonth: b.dayOfMonth, cron: b.frequency === 'CRON' ? cron : undefined },
    };
    const enabled = b.enabled ?? true;
    return {
      name: b.name, report_type: b.reportType, format: b.format ?? 'CSV', params: JSON.stringify(params), frequency: b.frequency, cron, timezone,
      lookback_days: b.lookbackDays ?? DEFAULT_LOOKBACK_DAYS[b.frequency], recipient_ids: recipientIds, email_recipients: b.emailRecipients ?? true, enabled,
      next_run_at: enabled ? nextCronRun(cron, timezone) : null, last_error: null,
    };
  };

  app.get('/schedules', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'My scheduled reports' },
  }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await schedBase().where('s.owner_id', '=', p.userId ?? NIL).orderBy('s.created_at', 'desc').execute();
    return { items: await schedDto(rows), frequencies: REPORT_FREQUENCIES };
  });

  app.get('/schedules/:id', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'One of my scheduled reports', params: idParam },
  }, async (req) => (await schedDto([await loadOwnSchedule(req.requirePrincipal(), req.params.id)]))[0]);

  app.post('/schedules', {
    preHandler: app.authorize('reports:generate'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['reports'], summary: 'Create a scheduled (recurring) report', body: scheduleCreate },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw forbidden('Scheduled reports require an interactive user');
    const values = await validateSchedule(p, req.body, req.actor());
    const row = await db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('report_schedules').values({ ...values, owner_id: p.userId! }).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'REPORT_SCHEDULE_CREATED', resourceType: 'report_schedule', resourceId: r.id,
        details: { name: r.name, reportType: r.report_type, format: r.format, cron: r.cron, timezone: r.timezone, lookbackDays: r.lookback_days, recipients: r.recipient_ids, enabled: r.enabled },
      });
      return r;
    });
    return reply.status(201).send((await schedDto([row]))[0]);
  });

  app.patch('/schedules/:id', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Update one of my scheduled reports', params: idParam, body: schedulePatch },
  }, async (req) => {
    const p = req.requirePrincipal();
    const cur = await loadOwnSchedule(p, req.params.id);
    if (!Object.keys(req.body).length) throw validationFailed('Nothing to update');
    const prm = cur.params as ScheduleParamsJson;
    const merged: ScheduleInput = {
      name: cur.name, reportType: cur.report_type as ReportType, format: cur.format as ScheduleInput['format'], frequency: cur.frequency as ScheduleInput['frequency'],
      ...Object.fromEntries(Object.entries(prm.timing ?? {}).filter(([, v]) => v !== undefined && v !== null)),
      timezone: cur.timezone, lookbackDays: cur.lookback_days, orgUnitId: prm.orgUnitId ?? null, actorId: prm.actorId ?? null, inactiveDays: prm.inactiveDays ?? null,
      recipientIds: cur.recipient_ids, emailRecipients: cur.email_recipients, enabled: cur.enabled,
      ...req.body,
    };
    if (req.body.frequency && req.body.frequency !== cur.frequency && !req.body.lookbackDays) merged.lookbackDays = DEFAULT_LOOKBACK_DAYS[req.body.frequency];
    const values = await validateSchedule(p, merged, req.actor());
    const row = await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('report_schedules').set(values).where('id', '=', cur.id).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'REPORT_SCHEDULE_UPDATED', resourceType: 'report_schedule', resourceId: r.id,
        details: {
          before: { name: cur.name, reportType: cur.report_type, format: cur.format, cron: cur.cron, recipients: cur.recipient_ids, enabled: cur.enabled },
          after: { name: r.name, reportType: r.report_type, format: r.format, cron: r.cron, recipients: r.recipient_ids, enabled: r.enabled },
        },
      });
      return r;
    });
    return (await schedDto([row]))[0];
  });

  app.delete('/schedules/:id', {
    preHandler: app.authorize('reports:generate'),
    schema: { tags: ['reports'], summary: 'Delete one of my scheduled reports (past runs are kept)', params: idParam },
  }, async (req) => {
    const p = req.requirePrincipal();
    const cur = await loadOwnSchedule(p, req.params.id);
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('report_schedules').where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'REPORT_SCHEDULE_DELETED', resourceType: 'report_schedule', resourceId: cur.id, details: { name: cur.name, reportType: cur.report_type, cron: cur.cron } });
    });
    return { deleted: true };
  });
}
