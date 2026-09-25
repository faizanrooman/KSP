/**
 * System monitoring (spec 19) — system:monitor only.
 *   GET /system/health            aggregate health: API, DB, S3, queues, worker heartbeats, backups, ledger, storage
 *   GET /system/metrics-summary   p50/p95/p99 latency + error rate (last 15 min, this API instance), top routes
 * Prometheus scraping uses the internal METRICS_PORT listener (server.ts), not these endpoints.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { httpDuration, httpRequests, windowSummary } from '../../plugins/metrics.js';
import { fullHealth } from './health-lib.js';

export const prefix = '/system';

export default async function system(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/health', {
    preHandler: app.authorize('system:monitor'),
    schema: { tags: ['system'], summary: 'Aggregate service health (API, database, object storage, queues, workers, backups, audit ledger, storage)' },
  }, async () => fullHealth(app));

  app.get('/metrics-summary', {
    preHandler: app.authorize('system:monitor'),
    schema: { tags: ['system'], summary: 'Latency percentiles and error rates for this API instance' },
  }, async () => {
    const hist = await httpDuration.get();
    const routes = new Map<string, { route: string; method: string; count: number; sum: number; errors5xx: number }>();
    for (const v of hist.values) {
      const l = v.labels as { method?: string; route?: string; status?: string };
      const key = `${l.method} ${l.route}`;
      const r = routes.get(key) ?? { route: String(l.route), method: String(l.method), count: 0, sum: 0, errors5xx: 0 };
      if (v.metricName?.endsWith('_count')) {
        r.count += v.value;
        if (Number(l.status) >= 500) r.errors5xx += v.value;
      } else if (v.metricName?.endsWith('_sum')) r.sum += v.value;
      else continue;
      routes.set(key, r);
    }
    const all = [...routes.values()].filter((r) => r.route !== '/health/live' && r.route !== '/health/ready');
    const totals = (await httpRequests.get()).values.reduce(
      (acc, v) => {
        acc.requests += v.value;
        if (Number((v.labels as { status?: string }).status) >= 500) acc.errors5xx += v.value;
        return acc;
      },
      { requests: 0, errors5xx: 0 },
    );
    return {
      instance: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      window: windowSummary(),
      sinceStart: { ...totals, errorRate5xx: totals.requests ? totals.errors5xx / totals.requests : 0 },
      slowestRoutes: all.filter((r) => r.count >= 3).map((r) => ({ method: r.method, route: r.route, count: r.count, meanMs: Math.round((r.sum / r.count) * 1000), errors5xx: r.errors5xx })).sort((a, b) => b.meanMs - a.meanMs).slice(0, 10),
      note: 'Per-instance figures; fleet-wide SLO measurement uses Prometheus (see docs/MONITORING.md).',
    };
  });
}
