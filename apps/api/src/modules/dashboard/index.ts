/**
 * Operational dashboard (spec 17) — GET /dashboard/summary?from&to&orgUnitId (dashboard:view).
 *
 * Every number is scoped to the viewer: evidence through evidenceVisibleSql (jurisdiction, own, case, share),
 * upload sessions through evidence:read jurisdiction or the viewer's own sessions, AI jobs/review through
 * visible evidence, alerts through alertScopeSql. Storage and system-health sections are only returned to
 * system:monitor holders. Sections the viewer may not see are `null` (never zero-filled from wider data).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type RawBuilder } from 'kysely';
import { queueStats } from '@ksp/core';
import { evidenceVisibleSql } from '../../lib/access.js';
import { hasPermission, hasPermissionAt, scopePaths, type Principal } from '../../lib/principal.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { alertScopeSql, resourceLink } from '../alerts/index.js';
import { databaseHealth, storageHealth, storageUtilisation, summariseQueues, workerHeartbeats } from '../system/health-lib.js';

export const prefix = '/dashboard';

const query = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  orgUnitId: z.string().uuid().optional(),
});

/** Upload sessions the principal may see: evidence:read jurisdiction over the session's unit, or own sessions. */
function sessionVisibleSql(p: Principal): RawBuilder<boolean> {
  const paths = scopePaths(p, 'evidence:read');
  const parts: RawBuilder<unknown>[] = [];
  if (paths.length) parts.push(sql`o.path <@ ${sql.val(paths)}::ltree[]`);
  if (p.userId) parts.push(sql`us.created_by = ${p.userId}::uuid`);
  return parts.length ? sql<boolean>`(${sql.join(parts, sql` OR `)})` : sql<boolean>`false`;
}

const n = (v: unknown) => Number(v ?? 0);

export default async function dashboard(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  app.get('/summary', {
    preHandler: app.authorize('dashboard:view'),
    schema: { tags: ['dashboard'], summary: 'Role-aware operational dashboard (scoped to the viewer)', querystring: query },
  }, async (req) => {
    const p = req.requirePrincipal();
    const to = req.query.to ?? new Date();
    const from = req.query.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw validationFailed('"from" must be before "to"');
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw validationFailed('The dashboard period may not exceed 366 days');
    let org: { id: string; name: string; code: string; path: string } | null = null;
    if (req.query.orgUnitId) {
      org = (await db.selectFrom('org_units').select(['id', 'name', 'code', 'path']).where('id', '=', req.query.orgUnitId).executeTakeFirst()) ?? null;
      // SEC-R12: a unit outside the viewer's dashboard jurisdiction answers exactly like a non-existent one.
      if (!org || !hasPermissionAt(p, 'dashboard:view', org.path)) throw notFound('Org unit');
    }
    const orgE = org ? sql<boolean>`e.org_path <@ ${org.path}::ltree` : sql<boolean>`true`;
    const orgO = org ? sql<boolean>`o.path <@ ${org.path}::ltree` : sql<boolean>`true`;
    const visE = sql<boolean>`${evidenceVisibleSql(p, 'e', { relationships: 'initplan' })} AND ${orgE}`;
    const visS = sql<boolean>`${sessionVisibleSql(p)} AND ${orgO}`;
    const timings: Record<string, number> = {};
    const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = performance.now();
      try {
        return await fn();
      } finally {
        timings[name] = Math.round((performance.now() - t) * 10) / 10;
      }
    };
    const days = sql`generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') AS d(day)`;

    const sections = {
      uploads: true,
      evidence: true,
      analytics: hasPermission(p, 'ai:request') || hasPermission(p, 'ai:review') || hasPermission(p, 'ai:models_manage'),
      alerts: hasPermission(p, 'alerts:read'),
      storage: hasPermission(p, 'system:monitor'),
      system: hasPermission(p, 'system:monitor'),
    };
    const scopeKind = scopePaths(p, 'evidence:read').length ? 'JURISDICTION' : hasPermission(p, 'evidence:read_own') ? 'OWN' : 'RELATIONSHIP';

    const uploads = time('uploads', async () => {
      const [byStatus, series] = await Promise.all([
        sql<{ status: string; n: number }>`SELECT us.status, count(*)::int AS n FROM upload_sessions us JOIN org_units o ON o.id = us.org_unit_id
          WHERE ${visS} AND us.created_at >= ${from} AND us.created_at < ${to} GROUP BY us.status ORDER BY us.status`.execute(db),
        sql<{ day: string; sessions: number; failed: number; bytes: string }>`
          SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(x.sessions, 0)::int AS sessions, coalesce(x.failed, 0)::int AS failed, coalesce(x.bytes, 0)::text AS bytes
            FROM ${days}
            LEFT JOIN (SELECT date_trunc('day', us.created_at) AS day, count(*) AS sessions, count(*) FILTER (WHERE us.status = 'FAILED') AS failed,
                              sum(us.received_bytes) FILTER (WHERE us.status = 'COMPLETED') AS bytes
                         FROM upload_sessions us JOIN org_units o ON o.id = us.org_unit_id
                        WHERE ${visS} AND us.created_at >= ${from} AND us.created_at < ${to} GROUP BY 1) x ON x.day = d.day
           ORDER BY d.day`.execute(db),
      ]);
      const total = byStatus.rows.reduce((s, r) => s + r.n, 0);
      return {
        total,
        byStatus: byStatus.rows,
        failed: byStatus.rows.find((r) => r.status === 'FAILED')?.n ?? 0,
        inProgress: byStatus.rows.filter((r) => ['INITIATED', 'UPLOADING', 'COMPLETING'].includes(r.status)).reduce((s, r) => s + r.n, 0),
        perDay: series.rows.map((r) => ({ day: r.day, sessions: r.sessions, failed: r.failed, bytes: n(r.bytes) })),
      };
    });

    const evidence = time('evidence', async () => {
      const [totals, perDay, byStation, byCategory] = await Promise.all([
        sql<Record<string, string | number>>`
          SELECT count(*) FILTER (WHERE e.status NOT IN ('DISPOSED','REJECTED'))::int AS total,
                 coalesce(sum(e.size_bytes) FILTER (WHERE e.status NOT IN ('DISPOSED','REJECTED')), 0)::text AS total_bytes,
                 count(*) FILTER (WHERE e.registered_at >= ${from} AND e.registered_at < ${to})::int AS registered_in_period,
                 count(*) FILTER (WHERE e.status = 'REGISTERED' AND e.media_status IN ('PENDING','PROCESSING'))::int AS pending_media,
                 count(*) FILTER (WHERE e.status = 'REGISTERED' AND e.media_status = 'FAILED')::int AS media_failed,
                 count(*) FILTER (WHERE e.status = 'QUARANTINED')::int AS quarantined,
                 count(*) FILTER (WHERE e.legal_hold AND e.status <> 'DISPOSED')::int AS legal_holds,
                 count(*) FILTER (WHERE e.status = 'DISPOSAL_PENDING')::int AS disposal_pending,
                 count(*) FILTER (WHERE e.status = 'REGISTERED' AND e.retain_until < now() AND NOT e.legal_hold)::int AS retention_overdue,
                 count(*) FILTER (WHERE e.status = 'DISPOSED' AND e.disposed_at >= ${from} AND e.disposed_at < ${to})::int AS disposed_in_period
            FROM evidence e WHERE ${visE}`.execute(db),
        sql<{ day: string; registered: number; bytes: string }>`
          SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(x.n, 0)::int AS registered, coalesce(x.bytes, 0)::text AS bytes
            FROM ${days}
            LEFT JOIN (SELECT date_trunc('day', e.registered_at) AS day, count(*) AS n, sum(e.size_bytes) AS bytes FROM evidence e
                        WHERE ${visE} AND e.registered_at >= ${from} AND e.registered_at < ${to} GROUP BY 1) x ON x.day = d.day
           ORDER BY d.day`.execute(db),
        sql<{ id: string; code: string; name: string; items: number; bytes: string; in_period: number; holds: number; media_failed: number; quarantined: number }>`
          SELECT o.id, o.code, o.name, count(*)::int AS items, coalesce(sum(e.size_bytes), 0)::text AS bytes,
                 count(*) FILTER (WHERE e.registered_at >= ${from} AND e.registered_at < ${to})::int AS in_period,
                 count(*) FILTER (WHERE e.legal_hold)::int AS holds, count(*) FILTER (WHERE e.media_status = 'FAILED')::int AS media_failed,
                 count(*) FILTER (WHERE e.status = 'QUARANTINED')::int AS quarantined
            FROM evidence e JOIN org_units o ON o.id = e.org_unit_id
           WHERE ${visE} AND e.status NOT IN ('DISPOSED','REJECTED')
           GROUP BY o.id, o.code, o.name ORDER BY items DESC, o.code LIMIT 50`.execute(db),
        sql<{ category: string; items: number }>`
          SELECT coalesce(e.category, 'Uncategorised') AS category, count(*)::int AS items FROM evidence e
           WHERE ${visE} AND e.status NOT IN ('DISPOSED','REJECTED') GROUP BY 1 ORDER BY items DESC LIMIT 20`.execute(db),
      ]);
      const t = totals.rows[0] ?? {};
      return {
        total: n(t.total), totalBytes: n(t.total_bytes), registeredInPeriod: n(t.registered_in_period), pendingMediaProcessing: n(t.pending_media),
        mediaFailed: n(t.media_failed), quarantined: n(t.quarantined), legalHolds: n(t.legal_holds), disposalPending: n(t.disposal_pending),
        retentionOverdue: n(t.retention_overdue), disposedInPeriod: n(t.disposed_in_period),
        perDay: perDay.rows.map((r) => ({ day: r.day, registered: r.registered, bytes: n(r.bytes) })),
        byStation: byStation.rows.map((r) => ({ orgUnitId: r.id, code: r.code, name: r.name, items: r.items, bytes: n(r.bytes), registeredInPeriod: r.in_period, legalHolds: r.holds, mediaFailed: r.media_failed, quarantined: r.quarantined })),
        byCategory: byCategory.rows,
      };
    });

    const analytics = sections.analytics
      ? time('analytics', async () => {
          const [jobs, queue, outcomes] = await Promise.all([
            sql<{ status: string; n: number }>`SELECT j.status, count(*)::int AS n FROM ai_jobs j JOIN evidence e ON e.id = j.evidence_id
              WHERE ${visE} AND (j.status IN ('QUEUED','RUNNING') OR (j.created_at >= ${from} AND j.created_at < ${to})) GROUP BY j.status`.execute(db),
            sql<{ status: string; n: number }>`SELECT d.review_status AS status, count(*)::int AS n FROM ai_detections d JOIN evidence e ON e.id = d.evidence_id
              WHERE ${visE} AND d.review_status IN ('PENDING','NEEDS_SECOND_REVIEW') GROUP BY d.review_status`.execute(db),
            sql<{ status: string; n: number }>`SELECT r.new_status AS status, count(*)::int AS n FROM ai_review_events r JOIN ai_detections d ON d.id = r.detection_id JOIN evidence e ON e.id = d.evidence_id
              WHERE ${visE} AND r.created_at >= ${from} AND r.created_at < ${to} AND r.new_status IN ('APPROVED','REJECTED','NEEDS_SECOND_REVIEW') GROUP BY r.new_status`.execute(db),
          ]);
          const get = (rows: Array<{ status: string; n: number }>, s: string) => rows.find((r) => r.status === s)?.n ?? 0;
          const approved = get(outcomes.rows, 'APPROVED');
          const rejected = get(outcomes.rows, 'REJECTED');
          const decided = approved + rejected;
          return {
            jobs: { queued: get(jobs.rows, 'QUEUED'), running: get(jobs.rows, 'RUNNING'), completed: get(jobs.rows, 'COMPLETED'), failed: get(jobs.rows, 'FAILED'), cancelled: get(jobs.rows, 'CANCELLED') },
            reviewQueue: { pending: get(queue.rows, 'PENDING'), needsSecondReview: get(queue.rows, 'NEEDS_SECOND_REVIEW') },
            reviewOutcomes: { approved, rejected, escalated: get(outcomes.rows, 'NEEDS_SECOND_REVIEW'), approvalRate: decided ? approved / decided : null, rejectionRate: decided ? rejected / decided : null },
          };
        })
      : null;

    const alerts = sections.alerts
      ? time('alerts', async () => {
          const rows = await db.selectFrom('alerts as a').select(['a.severity', sql<number>`count(*)::int`.as('n')])
            .where('a.status', '<>', 'RESOLVED').where(alertScopeSql(p, 'alerts:read'))
            .$if(!!org, (q) => q.where(sql<boolean>`EXISTS (SELECT 1 FROM org_units ou WHERE ou.id = a.org_unit_id AND ou.path <@ ${org!.path}::ltree)`))
            .groupBy('a.severity').execute();
          const recent = await db.selectFrom('alerts as a').select(['a.id', 'a.severity', 'a.title', 'a.rule_code', 'a.last_seen_at', 'a.status'])
            .where('a.status', '<>', 'RESOLVED').where(alertScopeSql(p, 'alerts:read'))
            .$if(!!org, (q) => q.where(sql<boolean>`EXISTS (SELECT 1 FROM org_units ou WHERE ou.id = a.org_unit_id AND ou.path <@ ${org!.path}::ltree)`))
            .orderBy(sql`CASE a.severity WHEN 'CRITICAL' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END`, 'desc').orderBy('a.last_seen_at', 'desc').limit(5).execute();
          const bySeverity = { CRITICAL: 0, WARNING: 0, INFO: 0 } as Record<string, number>;
          for (const r of rows) bySeverity[r.severity] = r.n;
          return { open: rows.reduce((s, r) => s + r.n, 0), bySeverity, recent: recent.map((a) => ({ id: a.id, severity: a.severity, title: a.title, ruleCode: a.rule_code, lastSeenAt: a.last_seen_at, status: a.status })) };
        })
      : null;

    const recentFailures = time('recentFailures', async () => {
      const { rows } = await sql<{ kind: string; id: string; title: string; reason: string | null; at: Date; resource_type: string }>`
        (SELECT 'UPLOAD_FAILED' AS kind, us.id::text AS id, us.original_filename AS title, left(us.error, 300) AS reason, us.updated_at AS at, 'upload_session' AS resource_type
           FROM upload_sessions us JOIN org_units o ON o.id = us.org_unit_id
          WHERE ${visS} AND us.status = 'FAILED' AND us.updated_at >= ${from} ORDER BY us.updated_at DESC LIMIT 10)
        UNION ALL
        (SELECT 'QUARANTINED', e.id::text, coalesce(e.evidence_number, e.original_filename), left(e.status_reason, 300), e.updated_at, 'evidence'
           FROM evidence e WHERE ${visE} AND e.status = 'QUARANTINED' ORDER BY e.updated_at DESC LIMIT 10)
        UNION ALL
        (SELECT 'MEDIA_FAILED', e.id::text, coalesce(e.evidence_number, e.original_filename), left(e.media_error, 300), e.updated_at, 'evidence'
           FROM evidence e WHERE ${visE} AND e.status = 'REGISTERED' AND e.media_status = 'FAILED' ORDER BY e.updated_at DESC LIMIT 10)
        ORDER BY at DESC LIMIT 15`.execute(db);
      return rows.map((r) => ({ kind: r.kind, id: r.id, title: r.title, reason: r.reason, at: r.at, link: resourceLink(r.resource_type, r.id) }));
    });

    const storageSection = sections.storage ? time('storage', () => storageUtilisation(app)) : null;
    const systemSection = sections.system
      ? time('system', async () => {
          const [database, objectStorage, qs, workers] = await Promise.all([databaseHealth(app), storageHealth(app), queueStats(db), workerHeartbeats(app)]);
          return {
            database: { ok: database.ok, ms: database.ms, version: database.version, connections: database.connections },
            objectStorage: { ok: objectStorage.ok, ms: objectStorage.ms },
            queues: { summary: summariseQueues(qs), items: qs.filter((q) => !q.deadLetter || q.queued > 0) },
            workers: { alive: workers.alive, services: workers.services, staleAfterSeconds: workers.staleAfterSeconds },
          };
        })
      : null;

    const t0 = performance.now();
    const [u, ev, an, al, rf, st, sy] = await Promise.all([uploads, evidence, analytics, alerts, recentFailures, storageSection, systemSection]);
    return {
      meta: { from, to, orgUnit: org ? { id: org.id, name: org.name, code: org.code } : null, generatedAt: new Date(), scope: scopeKind, sections, timingsMs: { ...timings, total: Math.round(performance.now() - t0) } },
      uploads: u, evidence: ev, analytics: an, alerts: al, recentFailures: rf, storage: st, system: sy,
    };
  });
}
