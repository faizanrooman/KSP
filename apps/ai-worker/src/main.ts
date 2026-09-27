/**
 * Isolated AI worker. Connects ONLY as ksp_ai (DATABASE_AI_URL) and to S3 with the AI credentials (derived bucket).
 * Woken by NOTIFY on AI_JOBS_CHANNEL (API sends job ids / 'watchlist'), plus a safety poll.
 */
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, loadConfig, logger, sql, Storage } from '@ksp/core';
import { AI_JOBS_CHANNEL } from '@ksp/shared';
import type { AiContext } from './context.js';
import { claimJob, runJob } from './pipeline.js';
import { embedPendingWatchlistEntries, reapStaleJobs } from './watchlist.js';
import { aiStats, jobStarted, recordJob, startAiHeartbeat, startMetricsServer } from './metrics.js';

process.env.KSP_SERVICE ??= 'ksp-ai-worker';

export function createAiContext(): AiContext & { destroy: () => Promise<void> } {
  const cfg = loadConfig();
  if (!cfg.DATABASE_AI_URL) throw new Error('DATABASE_AI_URL (role ksp_ai) is required; the AI worker never uses the application role');
  const { db } = createDb(cfg.DATABASE_AI_URL, 4);
  const storage = new Storage({ accessKey: cfg.S3_AI_ACCESS_KEY, secretKey: cfg.S3_AI_SECRET_KEY });
  const log = logger().child({ component: 'ai-worker' });
  if (!cfg.S3_AI_ACCESS_KEY && cfg.NODE_ENV === 'production') throw new Error('S3_AI_ACCESS_KEY/S3_AI_SECRET_KEY (derived-bucket-only identity) are required in production');
  return { db, storage, cfg, log, workerName: `ai-worker@${hostname()}`, destroy: () => db.destroy() };
}

/** Process queued jobs until none are left (used by the loop and by tests). */
export async function drainJobs(ctx: AiContext, max = Infinity): Promise<number> {
  let n = 0;
  while (n < max) {
    const job = await claimJob(ctx);
    if (!job) break;
    const t0 = Date.now();
    jobStarted(job.queue_wait_seconds);
    let outcome = 'FAILED';
    try {
      outcome = await runJob(ctx, job);
    } finally {
      const frames = await ctx.db.selectFrom('ai_jobs').select(sql<number>`coalesce((stats->>'framesProcessed')::int, 0)`.as('f')).where('id', '=', job.id).executeTakeFirst().catch(() => undefined);
      recordJob(outcome, (Date.now() - t0) / 1000, frames?.f ?? 0);
    }
    n++;
  }
  return n;
}

export interface StartAiWorkerOptions {
  /** Prometheus port (default METRICS_PORT + 2); `false` disables the endpoint. */
  metricsPort?: number | false;
  heartbeatIntervalMs?: number;
}

export async function startAiWorker(opts: StartAiWorkerOptions = {}): Promise<(() => Promise<void>) & { metricsPort?: number }> {
  const ctx = createAiContext();
  const concurrency = Math.max(1, Number(process.env.AI_WORKER_CONCURRENCY ?? 1));
  const heartbeat = startAiHeartbeat(ctx.db, () => ({ concurrency, running: aiStats.running }), ctx.log, undefined, opts.heartbeatIntervalMs);
  const metricsPort = opts.metricsPort === false ? undefined : opts.metricsPort ?? ctx.cfg.METRICS_PORT + 2;
  const metrics = metricsPort === undefined ? undefined : await startMetricsServer(metricsPort, ctx.cfg.METRICS_HOST);
  const waiters = new Set<() => void>();
  const wakeAll = () => { for (const w of [...waiters]) w(); };
  let stopping = false;
  const listener = new pg.Client({ connectionString: ctx.cfg.DATABASE_AI_URL, application_name: 'ksp-ai-worker-listen' });
  await listener.connect();
  listener.on('notification', () => wakeAll());
  listener.on('error', (err) => ctx.log.error({ err }, 'LISTEN connection error'));
  await listener.query(`LISTEN ${AI_JOBS_CHANNEL}`);
  await reapStaleJobs(ctx).catch((err) => ctx.log.error({ err }, 'stale job reaper failed'));

  const loop = async (slot: number) => {
    while (!stopping) {
      try {
        if (slot === 0) await embedPendingWatchlistEntries(ctx);
        await drainJobs(ctx);
      } catch (err) {
        ctx.log.error({ err }, 'ai worker loop error');
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          waiters.delete(done);
          resolve();
        };
        const t = setTimeout(done, 15_000);
        waiters.add(done);
      });
    }
  };
  const reaper = setInterval(() => void reapStaleJobs(ctx).catch(() => undefined), 60_000);
  const loops = Array.from({ length: concurrency }, (_, i) => loop(i));
  ctx.log.info({ concurrency }, 'ai worker started (role ksp_ai)');
  const stop = async () => {
    stopping = true;
    heartbeat.stop();
    await new Promise<void>((r) => (metrics ? metrics.close(() => r()) : r()));
    clearInterval(reaper);
    wakeAll();
    await listener.end().catch(() => undefined);
    await Promise.race([Promise.all(loops), new Promise((r) => setTimeout(r, 5000))]);
    await ctx.destroy();
  };
  const addr = metrics?.address();
  return Object.assign(stop, { metricsPort: addr && typeof addr === 'object' ? addr.port : undefined });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const stop = await startAiWorker();
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
