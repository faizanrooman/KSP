/**
 * Worker observability: Prometheus metrics (jobs by queue, durations, queue depth/age, ffmpeg durations,
 * fixity results) on the default prom-client registry, pg-boss handler instrumentation and the 30 s
 * heartbeat row (worker_heartbeats) that /system/health reads.
 */
import { hostname } from 'node:os';
import client from 'prom-client';
import { sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { HEARTBEAT_INTERVAL_MS, mediaObservers, queueStats, writeHeartbeat, type Database, type HeartbeatIdentity } from '@ksp/core';

export const register = client.register;

const get = <T>(name: string, make: () => T): T => (register.getSingleMetric(name) as T | undefined) ?? make();

export const jobsProcessed = get('ksp_worker_jobs_processed_total', () =>
  new client.Counter({ name: 'ksp_worker_jobs_processed_total', help: 'Jobs handled by this worker, by queue and outcome', labelNames: ['queue', 'outcome'] }));
export const jobDuration = get('ksp_worker_job_duration_seconds', () =>
  new client.Histogram({ name: 'ksp_worker_job_duration_seconds', help: 'Job handler duration by queue', labelNames: ['queue'], buckets: [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600] }));
export const ffmpegDuration = get('ksp_worker_ffmpeg_duration_seconds', () =>
  new client.Histogram({ name: 'ksp_worker_ffmpeg_duration_seconds', help: 'FFmpeg process run time', labelNames: ['outcome'], buckets: [0.5, 2, 5, 15, 60, 300, 900, 3600] }));
export const heartbeatGauge = get('ksp_worker_heartbeat_timestamp_seconds', () =>
  new client.Gauge({ name: 'ksp_worker_heartbeat_timestamp_seconds', help: 'Unix time of the last successful heartbeat write' }));

let dbForGauges: Database | undefined;
/** Queue depth / age and 24 h fixity results, collected from the database at scrape time. */
export function registerDbGauges(db: Database): void {
  dbForGauges = db;
  if (register.getSingleMetric('ksp_queue_depth')) return;
  new client.Gauge({
    name: 'ksp_queue_depth',
    help: 'pg-boss jobs by queue and state (queued = created+retry)',
    labelNames: ['queue', 'state'],
    async collect() {
      if (!dbForGauges) return;
      this.reset();
      for (const q of await queueStats(dbForGauges)) {
        this.set({ queue: q.queue, state: 'queued' }, q.queued);
        this.set({ queue: q.queue, state: 'active' }, q.active);
        this.set({ queue: q.queue, state: 'failed_24h' }, q.failed24h);
      }
    },
  });
  new client.Gauge({
    name: 'ksp_queue_oldest_job_age_seconds',
    help: 'Age of the oldest due-but-unstarted job per queue (0 when empty)',
    labelNames: ['queue'],
    async collect() {
      if (!dbForGauges) return;
      this.reset();
      for (const q of await queueStats(dbForGauges)) this.set({ queue: q.queue }, q.oldestQueuedSeconds ?? 0);
    },
  });
  new client.Gauge({
    name: 'ksp_fixity_checks_24h',
    help: 'Integrity (fixity) checks in the last 24 hours by result',
    labelNames: ['result'],
    async collect() {
      if (!dbForGauges) return;
      this.reset();
      const { rows } = await sql<{ ok: boolean; n: number }>`SELECT ok, count(*)::int AS n FROM integrity_checks WHERE checked_at > now() - interval '24 hours' GROUP BY ok`.execute(dbForGauges);
      this.set({ result: 'ok' }, rows.find((r) => r.ok)?.n ?? 0);
      this.set({ result: 'failed' }, rows.find((r) => !r.ok)?.n ?? 0);
    },
  });
}

const INSTRUMENTED = Symbol.for('ksp.instrumented');
type Handler = (jobs: unknown[]) => Promise<unknown>;

/** Wrap boss.work so every handler invocation is counted and timed per queue (idempotent). */
export function instrumentBoss(boss: PgBoss): PgBoss {
  const b = boss as PgBoss & { [INSTRUMENTED]?: boolean };
  if (b[INSTRUMENTED]) return boss;
  b[INSTRUMENTED] = true;
  const orig = boss.work.bind(boss) as (...args: unknown[]) => Promise<string>;
  (boss as unknown as { work: (...args: unknown[]) => Promise<string> }).work = (name: unknown, a: unknown, h?: unknown) => {
    const handler = (typeof a === 'function' ? a : h) as Handler;
    const opts = typeof a === 'function' ? undefined : a;
    const queue = String(name);
    const wrapped: Handler = async (jobs) => {
      const end = jobDuration.startTimer({ queue });
      const n = Array.isArray(jobs) ? jobs.length : 1;
      try {
        const r = await handler(jobs);
        jobsProcessed.inc({ queue, outcome: 'completed' }, n);
        return r;
      } catch (e) {
        jobsProcessed.inc({ queue, outcome: 'failed' }, n);
        throw e;
      } finally {
        end();
      }
    };
    return opts === undefined ? orig(queue, wrapped) : orig(queue, opts, wrapped);
  };
  return boss;
}

export function observeFfmpeg(): void {
  mediaObservers.onFfmpeg = (seconds, ok) => ffmpegDuration.observe({ outcome: ok ? 'ok' : 'failed' }, seconds);
}

export function heartbeatIdentity(service = process.env.KSP_SERVICE ?? 'ksp-worker'): HeartbeatIdentity {
  const host = hostname();
  return { id: `${service}:${host}:${process.pid}`, service, hostname: host, pid: process.pid, version: process.env.npm_package_version ?? process.env.KSP_VERSION, startedAt: new Date() };
}

/** Start the heartbeat loop; returns a stop function. Failures are logged, never fatal. */
export function startHeartbeat(db: Database, who: HeartbeatIdentity, info: () => Record<string, unknown>, log?: { warn: (o: object, m: string) => void }): () => void {
  const beat = async () => {
    try {
      await writeHeartbeat(db, who, info());
      heartbeatGauge.set(Date.now() / 1000);
    } catch (e) {
      log?.warn({ err: (e as Error).message }, 'heartbeat write failed');
    }
  };
  void beat();
  const t = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}
