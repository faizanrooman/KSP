/**
 * Background worker: consumes pg-boss queues (ingestion, media, export, reports, lifecycle, integrity)
 * and runs scheduled maintenance. Job modules are auto-loaded from src/jobs/<name>/index.(ts|js).
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import client from 'prom-client';
import { createDb, getQueue, loadConfig, logger, stopQueue, storage } from '@ksp/core';
import type { JobModule, WorkerContext } from './lib/context.js';
import { heartbeatIdentity, instrumentBoss, observeFfmpeg, registerDbGauges, startHeartbeat } from './lib/monitoring.js';

process.env.KSP_SERVICE ??= 'ksp-worker';
const here = dirname(fileURLToPath(import.meta.url));

export async function startWorker(only?: string[]): Promise<WorkerContext> {
  const cfg = loadConfig();
  const log = logger().child({ component: 'worker' });
  const { db, pool } = createDb(cfg.DATABASE_URL, Math.max(5, cfg.WORKER_CONCURRENCY * 3));
  const boss = instrumentBoss(await getQueue());
  await storage().ensureBuckets();
  const ctx: WorkerContext = { boss, db, pool, storage: storage(), cfg, log };
  const dir = join(here, 'jobs');
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const name of names) {
    if (only && !only.includes(name)) continue;
    const file = ['index.ts', 'index.js'].map((f) => join(dir, name, f)).find(existsSync);
    if (!file) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default: JobModule };
    await mod.default(ctx);
    log.info({ module: name }, 'job module registered');
  }
  return ctx;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = loadConfig();
  const ctx = await startWorker();
  client.collectDefaultMetrics({ prefix: 'ksp_worker_' });
  registerDbGauges(ctx.db);
  observeFfmpeg();
  const stopHeartbeat = startHeartbeat(ctx.db, heartbeatIdentity(), () => ({ concurrency: cfg.WORKER_CONCURRENCY, uptimeSeconds: Math.round(process.uptime()) }), ctx.log);
  const metrics = createServer(async (_req, res) => {
    res.setHeader('content-type', client.register.contentType);
    res.end(await client.register.metrics());
  }).listen(cfg.METRICS_PORT + 1, cfg.METRICS_HOST);
  ctx.log.info('worker started');
  const shutdown = async () => {
    stopHeartbeat();
    metrics.close();
    await stopQueue();
    await ctx.db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
