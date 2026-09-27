/**
 * Aggregate service health (spec 19): API process, database, object storage, queues, worker heartbeats,
 * backups, audit ledger, storage utilisation. Shared by GET /system/health and the dashboard.
 */
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { HEARTBEAT_STALE_SECONDS, integrityCoverage, queueStats, type BucketRole, type QueueStat } from '@ksp/core';
import type { FastifyInstance } from 'fastify';
import { getSettings } from '../../lib/settings.js';

const BUCKET_ROLES: BucketRole[] = ['staging', 'evidence', 'archive', 'longterm', 'derived', 'exports', 'reports'];
const startedAt = new Date();

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: Math.round(performance.now() - t), value };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), error: (e as Error).message.slice(0, 200) };
  }
}

export async function databaseHealth(app: FastifyInstance) {
  const r = await timed(async () => {
    const { rows } = await sql<{ version: string; max_conn: number; total: number; active: number; db_bytes: string; in_recovery: boolean }>`
      SELECT current_setting('server_version') AS version, current_setting('max_connections')::int AS max_conn,
             (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS total,
             (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
             pg_database_size(current_database())::text AS db_bytes, pg_is_in_recovery() AS in_recovery`.execute(app.db);
    return rows[0]!;
  });
  // Replication lag: visible only with pg_monitor; report null (not "0") when not observable.
  const repl = await timed(async () => {
    const { rows } = await sql<{ client: string | null; state: string | null; lag: number | null }>`
      SELECT coalesce(application_name, client_addr::text) AS client, state, extract(epoch FROM replay_lag)::float8 AS lag FROM pg_stat_replication`.execute(app.db);
    return rows;
  });
  const v = r.value;
  return {
    ok: r.ok, ms: r.ms, error: r.error,
    version: v?.version ?? null,
    sizeBytes: v ? Number(v.db_bytes) : null,
    inRecovery: v?.in_recovery ?? null,
    connections: v ? { total: v.total, active: v.active, max: v.max_conn, utilisation: v.max_conn ? v.total / v.max_conn : null } : null,
    pool: { total: app.pool.totalCount, idle: app.pool.idleCount, waiting: app.pool.waitingCount },
    replication: repl.ok ? (repl.value ?? []).map((x) => ({ client: x.client, state: x.state, lagSeconds: x.lag })) : null,
  };
}

export async function storageHealth(app: FastifyInstance) {
  const buckets = await Promise.all(BUCKET_ROLES.map(async (role) => {
    const r = await timed(() => app.storage.s3.send(new HeadBucketCommand({ Bucket: app.storage.bucket(role) })));
    return { role, ok: r.ok, ms: r.ms, error: r.error };
  }));
  return { ok: buckets.every((b) => b.ok), ms: Math.max(...buckets.map((b) => b.ms)), buckets };
}

export const AI_WORKER_SERVICE = 'ksp-ai-worker';

export async function workerHeartbeats(app: FastifyInstance) {
  const rows = await app.db
    .selectFrom('worker_heartbeats')
    .select(['id', 'service', 'hostname', 'pid', 'version', 'started_at', 'last_seen_at', 'info', sql<number>`extract(epoch FROM now() - last_seen_at)::float8`.as('age')])
    .where('last_seen_at', '>', sql<Date>`now() - interval '1 day'`)
    .orderBy('service')
    .orderBy('last_seen_at', 'desc')
    .execute();
  const items = rows.map((r) => ({
    id: r.id, service: r.service, hostname: r.hostname, pid: r.pid, version: r.version, startedAt: r.started_at, lastSeenAt: r.last_seen_at,
    ageSeconds: Math.round(r.age), alive: r.age <= HEARTBEAT_STALE_SECONDS, info: r.info as Record<string, unknown>,
  }));
  const services = [...new Set(items.map((i) => i.service))].map((s) => ({ service: s, alive: items.filter((i) => i.service === s && i.alive).length, stale: items.filter((i) => i.service === s && !i.alive).length }));
  const ai = items.filter((i) => i.service === AI_WORKER_SERVICE);
  const aiQueue = await app.db.selectFrom('ai_jobs').select([sql<number>`count(*)::int`.as('n'), sql<number | null>`extract(epoch FROM now() - min(created_at))::float8`.as('oldest')]).where('status', '=', 'QUEUED').executeTakeFirstOrThrow();
  const aiWorker = {
    alive: ai.filter((i) => i.alive).length, stale: ai.filter((i) => !i.alive).length, lastSeenAt: ai[0]?.lastSeenAt ?? null,
    queuedJobs: aiQueue.n, oldestQueuedSeconds: aiQueue.oldest === null ? null : Math.round(aiQueue.oldest),
  };
  // `alive` counts pg-boss workers only (the AI worker is reported separately so it cannot mask a dead worker).
  return { staleAfterSeconds: HEARTBEAT_STALE_SECONDS, items, services, alive: items.filter((i) => i.alive && i.service !== AI_WORKER_SERVICE).length, aiWorker };
}

export function summariseQueues(qs: QueueStat[]) {
  const work = qs.filter((q) => !q.deadLetter);
  return {
    totalQueued: work.reduce((s, q) => s + q.queued, 0),
    totalActive: work.reduce((s, q) => s + q.active, 0),
    failed24h: work.reduce((s, q) => s + q.failed24h, 0),
    deadLettered: qs.filter((q) => q.deadLetter).reduce((s, q) => s + q.queued, 0),
    oldestQueuedSeconds: work.reduce<number | null>((m, q) => (q.oldestQueuedSeconds === null ? m : Math.max(m ?? 0, q.oldestQueuedSeconds)), null),
  };
}

export async function backupStatus(app: FastifyInstance) {
  const last = await app.db.selectFrom('backup_runs').selectAll().orderBy('started_at', 'desc').limit(10).execute();
  const lastOk = await app.db.selectFrom('backup_runs').selectAll().where('status', '=', 'SUCCEEDED').orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
  const dto = (b: (typeof last)[number]) => ({ id: b.id, kind: b.kind, status: b.status, startedAt: b.started_at, finishedAt: b.finished_at, sizeBytes: b.size_bytes === null ? null : Number(b.size_bytes), sha256: b.sha256, location: b.location, error: b.error });
  const ageH = lastOk?.finished_at ? (Date.now() - new Date(lastOk.finished_at).getTime()) / 3600_000 : null;
  return { recorded: last.length > 0, lastSuccessful: lastOk ? dto(lastOk) : null, lastSuccessfulAgeHours: ageH === null ? null : Math.round(ageH * 10) / 10, recent: last.map(dto) };
}

export async function ledgerStatus(app: FastifyInstance) {
  const head = await app.db.selectFrom('audit_events').select(['seq', 'occurred_at', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  const cp = await app.db.selectFrom('audit_checkpoints').select(['head_seq', 'created_at', 'key_id', 'head_hash']).orderBy('head_seq', 'desc').limit(1).executeTakeFirst();
  const cur = await app.db.selectFrom('alert_cursors').select(['last_seq', 'state', 'updated_at']).where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').executeTakeFirst();
  const st = (cur?.state ?? {}) as { lastFullAt?: string; lastMode?: string; firstBadSeq?: number | null };
  return {
    headSeq: head ? Number(head.seq) : 0,
    headAt: head?.occurred_at ?? null,
    lastCheckpoint: cp ? { headSeq: Number(cp.head_seq), createdAt: cp.created_at, keyId: cp.key_id } : null,
    eventsSinceCheckpoint: head ? Number(head.seq) - (cp ? Number(cp.head_seq) : 0) : 0,
    verification: cur ? { verifiedThroughSeq: cur.last_seq === null ? null : Number(cur.last_seq), lastRunAt: cur.updated_at, lastFullAt: st.lastFullAt ?? null, lastMode: st.lastMode ?? null, firstBadSeq: st.firstBadSeq ?? null } : null,
  };
}

function roleOfBucket(app: FastifyInstance, bucket: string): string {
  return BUCKET_ROLES.find((role) => app.storage.bucket(role) === bucket) ?? 'other';
}

export async function storageUtilisation(app: FastifyInstance) {
  const settings = await getSettings(app.db);
  const { rows: latest } = await sql<{ bucket: string; tier: string; object_count: string; total_bytes: string; capacity_bytes: string | null; captured_at: Date; source: string; db_total_bytes: string | null }>`
    SELECT DISTINCT ON (bucket) bucket, tier, object_count, total_bytes, capacity_bytes, captured_at, source, db_total_bytes
      FROM storage_snapshots WHERE captured_at > now() - interval '2 days' ORDER BY bucket, captured_at DESC`.execute(app.db);
  const { rows: trend } = await sql<{ day: string; bytes: string }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(total_bytes)::text AS bytes FROM (
      SELECT DISTINCT ON (bucket, date_trunc('day', captured_at)) bucket, date_trunc('day', captured_at) AS day, total_bytes
        FROM storage_snapshots WHERE captured_at > now() - interval '30 days' ORDER BY bucket, date_trunc('day', captured_at), captured_at DESC) x
     GROUP BY day ORDER BY day`.execute(app.db);
  const used = latest.reduce((s, r) => s + Number(r.total_bytes), 0);
  const capacity = settings.storagePolicy.capacityBytes || null;
  const byTier = new Map<string, { tier: string; bytes: number; objects: number }>();
  for (const r of latest) {
    const t = byTier.get(r.tier) ?? { tier: r.tier, bytes: 0, objects: 0 };
    t.bytes += Number(r.total_bytes);
    t.objects += Number(r.object_count);
    byTier.set(r.tier, t);
  }
  const first = trend[0] ? Number(trend[0].bytes) : null;
  const lastT = trend.length ? Number(trend[trend.length - 1]!.bytes) : null;
  const days = trend.length > 1 ? trend.length - 1 : 0;
  return {
    capturedAt: latest.length ? latest.reduce((m, r) => (new Date(r.captured_at) > m ? new Date(r.captured_at) : m), new Date(0)) : null,
    usedBytes: used,
    capacityBytes: capacity,
    percentUsed: capacity ? Math.round((used / capacity) * 1000) / 10 : null,
    warnThresholdPercent: settings.storagePolicy.warnThresholdPercent,
    criticalThresholdPercent: settings.storagePolicy.criticalThresholdPercent,
    byTier: [...byTier.values()],
    // Clients see the bucket ROLE, never the physical bucket name (storage topology stays server-side).
    byBucket: latest.map((r) => ({ role: roleOfBucket(app, r.bucket), tier: r.tier, objects: Number(r.object_count), bytes: Number(r.total_bytes), capacityBytes: r.capacity_bytes === null ? null : Number(r.capacity_bytes), source: r.source, dbBytes: r.db_total_bytes === null ? null : Number(r.db_total_bytes), capturedAt: r.captured_at })),
    trend: trend.map((t) => ({ day: t.day, bytes: Number(t.bytes) })),
    growthBytesPerDay: first !== null && lastT !== null && days ? Math.round((lastT - first) / days) : null,
  };
}

export function apiProcess() {
  const m = process.memoryUsage();
  return { ok: true, pid: process.pid, node: process.version, startedAt, uptimeSeconds: Math.round(process.uptime()), rssBytes: m.rss, heapUsedBytes: m.heapUsed, version: process.env.KSP_VERSION ?? process.env.npm_package_version ?? null };
}

export function channelStatus() {
  return {
    inApp: 'ENABLED',
    webhook: process.env.ALERT_WEBHOOK_URL ? 'CONFIGURED' : 'NOT_CONFIGURED',
    email: process.env.ALERT_SMTP_URL ? 'CONFIGURED' : 'NOT_CONFIGURED',
  };
}

export async function fullHealth(app: FastifyInstance) {
  const t0 = performance.now();
  const [database, objectStorage] = await Promise.all([databaseHealth(app), storageHealth(app)]);
  const qs = database.ok ? await queueStats(app.db).catch(() => [] as QueueStat[]) : [];
  const [workers, backups, ledger, storageUse, alerts, integrity] = database.ok
    ? await Promise.all([
        workerHeartbeats(app), backupStatus(app), ledgerStatus(app), storageUtilisation(app),
        app.db.selectFrom('alerts').select(['severity', sql<number>`count(*)::int`.as('n')]).where('status', '<>', 'RESOLVED').groupBy('severity').execute(),
        integrityCoverage(app.db),
      ])
    : [null, null, null, null, [], null];
  const reasons: string[] = [];
  if (!database.ok) reasons.push('database unreachable');
  if (!objectStorage.ok) reasons.push('object storage unreachable');
  if (workers && workers.alive === 0) reasons.push('no live worker heartbeat');
  // AI analysis is optional: only degrade when an AI worker was seen in the last day or AI jobs are waiting.
  if (workers && workers.aiWorker.alive === 0 && (workers.aiWorker.stale > 0 || (workers.aiWorker.oldestQueuedSeconds ?? 0) > 300)) reasons.push('no live AI worker heartbeat');
  const q = summariseQueues(qs);
  if (q.deadLettered > 0) reasons.push(`${q.deadLettered} dead-lettered jobs`);
  if (backups && (!backups.lastSuccessful || (backups.lastSuccessfulAgeHours ?? 0) > 26)) reasons.push(backups.recorded ? 'no successful backup in the last 26 h' : 'no backup runs recorded');
  if (ledger?.verification?.firstBadSeq) reasons.push('audit ledger verification failed');
  if (integrity?.projectedCycleDays && integrity.projectedCycleDays > integrity.policy.fullCycleDays) reasons.push(`fixity sweep needs ${integrity.projectedCycleDays} days per full cycle (policy ${integrity.policy.fullCycleDays})`);
  return {
    status: !database.ok ? 'down' : reasons.length ? 'degraded' : 'ok',
    reasons,
    checkedAt: new Date(),
    tookMs: Math.round(performance.now() - t0),
    api: apiProcess(),
    database,
    objectStorage,
    queues: { summary: q, items: qs },
    workers,
    backups,
    auditLedger: ledger,
    storage: storageUse,
    integrity,
    openAlerts: Object.fromEntries(['CRITICAL', 'WARNING', 'INFO'].map((s) => [s, alerts.find((a) => a.severity === s)?.n ?? 0])),
    alertChannels: channelStatus(),
  };
}
