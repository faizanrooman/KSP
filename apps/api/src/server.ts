import { createServer } from 'node:http';
import { loadConfig, logger, stopQueue } from '@ksp/core';
import { buildApp } from './app.js';
import { registry } from './plugins/metrics.js';

process.env.KSP_SERVICE ??= 'ksp-api';
const cfg = loadConfig();
const log = logger();
const app = await buildApp();
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
