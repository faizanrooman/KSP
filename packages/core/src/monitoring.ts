/**
 * Operational monitoring queries shared by the API (/system/health, dashboards), the worker (Prometheus
 * gauges, heartbeats) and the alert evaluator (QUEUE_BACKLOG). Read-only against pgboss.job.
 */
import { sql } from 'kysely';
import type { Database, Tx } from './db/index.js';

export interface QueueStat {
  queue: string;
  queued: number; // created + retry
  active: number;
  failed24h: number;
  completed24h: number;
  /** Age in seconds of the oldest job that is due (start_after <= now) and not yet started; null if none. */
  oldestQueuedSeconds: number | null;
  deadLetter: boolean;
}

export async function queueStats(db: Database | Tx): Promise<QueueStat[]> {
  const { rows } = await sql<{ queue: string; queued: number; active: number; failed24h: number; completed24h: number; oldest: number | null }>`
    SELECT q.name AS queue,
           coalesce(j.queued, 0)::int AS queued,
           coalesce(j.active, 0)::int AS active,
           coalesce(j.failed24h, 0)::int AS "failed24h",
           coalesce(j.completed24h, 0)::int AS "completed24h",
           j.oldest::float8 AS oldest
      FROM pgboss.queue q
      LEFT JOIN (
        SELECT name,
               count(*) FILTER (WHERE state IN ('created','retry')) AS queued,
               count(*) FILTER (WHERE state = 'active') AS active,
               count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '24 hours') AS failed24h,
               count(*) FILTER (WHERE state = 'completed' AND completed_on > now() - interval '24 hours') AS completed24h,
               extract(epoch FROM now() - min(start_after) FILTER (WHERE state IN ('created','retry') AND start_after <= now())) AS oldest
          FROM pgboss.job
         GROUP BY name
      ) j ON j.name = q.name
     ORDER BY q.name`.execute(db);
  return rows.map((r) => ({
    queue: r.queue, queued: r.queued, active: r.active, failed24h: r.failed24h, completed24h: r.completed24h,
    oldestQueuedSeconds: r.oldest === null ? null : Math.max(0, Math.round(r.oldest)), deadLetter: r.queue.endsWith('.dead'),
  }));
}

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A process is considered down when its heartbeat is older than this. */
export const HEARTBEAT_STALE_SECONDS = 90;

export interface HeartbeatIdentity {
  id: string;
  service: string;
  hostname: string;
  pid: number;
  version?: string;
  startedAt: Date;
}

export async function writeHeartbeat(db: Database, who: HeartbeatIdentity, info: Record<string, unknown> = {}): Promise<void> {
  await db
    .insertInto('worker_heartbeats')
    .values({ id: who.id, service: who.service, hostname: who.hostname, pid: who.pid, version: who.version ?? null, started_at: who.startedAt, last_seen_at: new Date(), info: JSON.stringify(info) })
    .onConflict((oc) => oc.column('id').doUpdateSet({ last_seen_at: new Date(), info: JSON.stringify(info), version: who.version ?? null }))
    .execute();
}
