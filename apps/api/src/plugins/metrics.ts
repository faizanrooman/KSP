/**
 * API Prometheus metrics (served on the internal METRICS_PORT by server.ts, never through the public API)
 * plus an in-process sliding window (last 15 minutes) used by GET /system/metrics-summary.
 */
import fp from 'fastify-plugin';
import client from 'prom-client';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'ksp_api_' });

export const LATENCY_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpDuration = new client.Histogram({
  name: 'ksp_api_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});
export const httpRequests = new client.Counter({ name: 'ksp_api_http_requests_total', help: 'HTTP requests by route and status', labelNames: ['method', 'route', 'status'], registers: [registry] });
export const uploadBytes = new client.Counter({ name: 'ksp_api_upload_bytes_total', help: 'Bytes received for evidence uploads', registers: [registry] });
export const uploadSessions = new client.Counter({ name: 'ksp_api_upload_sessions_total', help: 'Upload sessions by lifecycle event', labelNames: ['event'], registers: [registry] });
/** Incremented by the auth module with a reason label (bad_password, unknown_user, ip_throttled, mfa). */
export const authFailures = new client.Counter({ name: 'ksp_api_auth_failures_total', help: 'Failed authentication attempts', labelNames: ['reason'], registers: [registry] });

let appRef: FastifyInstance | undefined;
new client.Gauge({
  name: 'ksp_api_active_sessions',
  help: 'Interactive sessions not revoked and not expired',
  registers: [registry],
  async collect() {
    if (!appRef) return;
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND idle_expires_at > now() AND absolute_expires_at > now()`.execute(appRef.db);
    this.set(r.rows[0]?.n ?? 0);
  },
});
new client.Gauge({
  name: 'ksp_api_db_pool_connections',
  help: 'API database pool connections by state',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    if (!appRef) return;
    const p = appRef.pool;
    this.set({ state: 'total' }, p.totalCount);
    this.set({ state: 'idle' }, p.idleCount);
    this.set({ state: 'waiting' }, p.waitingCount);
  },
});

// ---- sliding window for the UI summary -------------------------------------------------------------
interface Slot { minute: number; count: number; errors5xx: number; errors4xx: number; buckets: number[]; sum: number }
export const WINDOW_MINUTES = 15;
const slots: Slot[] = [];
function slotFor(now: number): Slot {
  const minute = Math.floor(now / 60_000);
  let s = slots[slots.length - 1];
  if (!s || s.minute !== minute) {
    s = { minute, count: 0, errors5xx: 0, errors4xx: 0, buckets: new Array(LATENCY_BUCKETS.length + 1).fill(0), sum: 0 };
    slots.push(s);
    while (slots.length && slots[0]!.minute <= minute - WINDOW_MINUTES) slots.shift();
  }
  return s;
}
export function recordRequest(seconds: number, status: number, now = Date.now()): void {
  const s = slotFor(now);
  s.count++;
  s.sum += seconds;
  if (status >= 500) s.errors5xx++;
  else if (status >= 400) s.errors4xx++;
  const i = LATENCY_BUCKETS.findIndex((b) => seconds <= b);
  s.buckets[i === -1 ? LATENCY_BUCKETS.length : i]!++;
}

/** Quantile estimate from bucket counts (linear interpolation inside the bucket, as histogram_quantile does). */
export function quantileFromBuckets(counts: number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const prev = cum;
    cum += counts[i]!;
    if (cum >= rank && counts[i]!) {
      if (i >= LATENCY_BUCKETS.length) return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]!; // +Inf bucket: report the top bound
      const lo = i === 0 ? 0 : LATENCY_BUCKETS[i - 1]!;
      const hi = LATENCY_BUCKETS[i]!;
      return lo + (hi - lo) * ((rank - prev) / counts[i]!);
    }
  }
  return LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1]!;
}

export function windowSummary(now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  const live = slots.filter((s) => s.minute > minute - WINDOW_MINUTES);
  const buckets = new Array(LATENCY_BUCKETS.length + 1).fill(0) as number[];
  let count = 0;
  let e5 = 0;
  let e4 = 0;
  let sum = 0;
  for (const s of live) {
    count += s.count;
    e5 += s.errors5xx;
    e4 += s.errors4xx;
    sum += s.sum;
    s.buckets.forEach((c, i) => (buckets[i]! += c));
  }
  const ms = (v: number | null) => (v === null ? null : Math.round(v * 1000));
  return {
    windowMinutes: WINDOW_MINUTES,
    requests: count,
    requestsPerMinute: Math.round((count / WINDOW_MINUTES) * 10) / 10,
    errorRate5xx: count ? e5 / count : 0,
    clientErrorRate4xx: count ? e4 / count : 0,
    latencyMs: { p50: ms(quantileFromBuckets(buckets, 0.5)), p95: ms(quantileFromBuckets(buckets, 0.95)), p99: ms(quantileFromBuckets(buckets, 0.99)), mean: count ? Math.round((sum / count) * 1000) : null },
  };
}

const EXCLUDED = new Set(['/health/live', '/health/ready']);

export default fp(async (app) => {
  appRef = app;
  app.addHook('onClose', async () => {
    if (appRef === app) appRef = undefined;
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    const labels = { method: req.method, route, status: String(status) };
    const seconds = reply.elapsedTime / 1000;
    httpDuration.observe(labels, seconds);
    httpRequests.inc(labels);
    if (!EXCLUDED.has(route)) recordRequest(seconds, status);
    if (status < 300) {
      if (req.method === 'PUT' && route === '/api/v1/uploads/:id/parts/:n') uploadBytes.inc(Number(req.headers['content-length'] ?? 0) || 0);
      else if (req.method === 'POST' && (route === '/api/v1/uploads' || route === '/api/v1/uploads/')) uploadSessions.inc({ event: 'created' });
      else if (req.method === 'POST' && route === '/api/v1/uploads/:id/complete') uploadSessions.inc({ event: 'completed' });
    }
  });
});
