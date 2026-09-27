import { createServer } from 'node:http';
import { enforcePreflight, loadConfig, logger, stopQueue } from '@ksp/core';
import { buildApp } from './app.js';
import { registry } from './plugins/metrics.js';

process.env.KSP_SERVICE ??= 'ksp-api';
const cfg = loadConfig();
const log = logger();
const app = await buildApp();
// Production: refuse to start with development/demo settings (docs/GO-LIVE-CHECKLIST.md). No-op in development/test.
try {
  await enforcePreflight({ cfg, service: 'api', db: app.db, log });
} catch (err) {
  console.error((err as Error).message);
  await app.close().catch(() => undefined);
  process.exit(78); // EX_CONFIG
}
await app.storage.ensureBuckets();
await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });

// Prometheus metrics on a separate internal port (not exposed through the public ingress).
const metrics = createServer(async (_req, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}).listen(cfg.METRICS_PORT, cfg.METRICS_HOST);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  metrics.close();
  await app.close();
  await stopQueue();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
