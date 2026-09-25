import fp from 'fastify-plugin';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'ksp_api_' });

export const httpDuration = new client.Histogram({
  name: 'ksp_api_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const uploadBytes = new client.Counter({ name: 'ksp_api_upload_bytes_total', help: 'Bytes received for evidence uploads', registers: [registry] });
export const authFailures = new client.Counter({ name: 'ksp_api_auth_failures_total', help: 'Failed authentication attempts', labelNames: ['reason'], registers: [registry] });

export default fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });
});
