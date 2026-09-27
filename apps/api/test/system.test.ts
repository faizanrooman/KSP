import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { writeHeartbeat } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { quantileFromBuckets, recordRequest, registry, windowSummary, LATENCY_BUCKETS } from '../src/plugins/metrics.js';

let app: FastifyInstance;
let admin: Agent, meera: Agent;

beforeAll(async () => {
  app = await evidenceTestSetup();
  [admin, meera] = await Promise.all([login('admin'), login('io.meera')]);
  await writeHeartbeat(app.db, { id: 'ksp-worker:test-host:1', service: 'ksp-worker', hostname: 'test-host', pid: 1, startedAt: new Date() }, { concurrency: 2 });
  await app.db.insertInto('worker_heartbeats').values({ id: 'ksp-ai-worker:old:2', service: 'ksp-ai-worker', hostname: 'old', pid: 2, started_at: new Date(Date.now() - 7200_000), last_seen_at: new Date(Date.now() - 600_000) })
    .onConflict((oc) => oc.column('id').doNothing()).execute();
  await app.db.insertInto('backup_runs').values({ kind: 'DB_BASE', status: 'SUCCEEDED', started_at: new Date(Date.now() - 3600_000), finished_at: new Date(Date.now() - 3000_000), size_bytes: 123456, sha256: 'a'.repeat(64), location: 'backup-vault/db/2026-09-25' }).execute();
}, 120_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('GET /system/health', () => {
  it('401 unauthenticated, 403 without system:monitor', async () => {
    expect((await new Agent(app).get('/api/v1/system/health')).status).toBe(401);
    expect((await meera.get('/api/v1/system/health')).status).toBe(403);
    expect((await meera.get('/api/v1/system/metrics-summary')).status).toBe(403);
  });

  it('aggregates API, DB, S3, queues, worker heartbeats, backups, ledger and storage', async () => {
    const r = await admin.get('/api/v1/system/health');
    expect(r.status).toBe(200);
    const h = r.body;
    expect(['ok', 'degraded']).toContain(h.status);
    expect(h.api).toMatchObject({ ok: true, pid: process.pid });
    expect(h.database).toMatchObject({ ok: true, version: expect.stringMatching(/^16/) });
    expect(h.database.connections.max).toBeGreaterThan(0);
    expect(h.objectStorage.ok).toBe(true);
    expect(h.objectStorage.buckets.map((b: { role: string }) => b.role).sort()).toEqual(['archive', 'derived', 'evidence', 'exports', 'longterm', 'reports', 'staging']);
    expect(h.queues.items.map((q: { queue: string }) => q.queue)).toEqual(expect.arrayContaining(['report.build', 'media.process', 'alerts.evaluate', 'report.build.dead']));
    const live = h.workers.items.find((w: { id: string }) => w.id === 'ksp-worker:test-host:1');
    expect(live).toMatchObject({ alive: true, service: 'ksp-worker', info: { concurrency: 2 } });
    expect(h.workers.items.find((w: { id: string }) => w.id === 'ksp-ai-worker:old:2')).toMatchObject({ alive: false });
    expect(h.backups.lastSuccessful).toMatchObject({ kind: 'DB_BASE', status: 'SUCCEEDED', sizeBytes: 123456 });
    expect(h.auditLedger.headSeq).toBeGreaterThan(0);
    expect(h.storage).toHaveProperty('byTier');
    expect(h.alertChannels).toMatchObject({ inApp: 'ENABLED', email: 'NOT_CONFIGURED' });
    expect(Object.keys(h.openAlerts).sort()).toEqual(['CRITICAL', 'INFO', 'WARNING']);
    expect(JSON.stringify(h)).not.toMatch(/X-Amz|password|secret_key/i);
  });

  it('degraded reasons: no successful backup recorded → reported (never claimed healthy)', async () => {
    await app.db.deleteFrom('backup_runs').execute();
    const h = (await admin.get('/api/v1/system/health')).body;
    expect(h.status).toBe('degraded');
    expect(h.reasons).toContain('no backup runs recorded');
  });
});

describe('metrics', () => {
  it('metrics-summary reports latency percentiles and error rates', async () => {
    await admin.get('/api/v1/auth/me');
    const r = await admin.get('/api/v1/system/metrics-summary');
    expect(r.status).toBe(200);
    expect(r.body.window.requests).toBeGreaterThan(0);
    expect(r.body.window.latencyMs.p50).toEqual(expect.any(Number));
    expect(r.body.window.latencyMs.p95).toBeGreaterThanOrEqual(r.body.window.latencyMs.p50);
    expect(r.body.sinceStart.requests).toBeGreaterThan(0);
  });

  it('Prometheus registry exposes the new series', async () => {
    await new Agent(app).post('/api/v1/auth/login', { username: 'io.meera', password: 'wrong-password-123' });
    const text = await registry.metrics();
    for (const name of ['ksp_api_http_requests_total', 'ksp_api_http_request_duration_seconds_bucket', 'ksp_api_active_sessions', 'ksp_api_db_pool_connections', 'ksp_api_upload_bytes_total', 'ksp_api_upload_sessions_total', 'ksp_api_auth_failures_total']) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/ksp_api_http_requests_total\{method="GET",route="\/api\/v1\/system\/health",status="200"\} \d+/);
    expect(text).toMatch(/ksp_api_auth_failures_total\{reason="bad_password"\} [1-9]/);
    expect(text).toMatch(/ksp_api_active_sessions [1-9]/);
    expect(text).toMatch(/ksp_api_db_pool_connections\{state="total"\} \d+/);
  });

  it('quantile estimation from buckets', () => {
    const counts = new Array(LATENCY_BUCKETS.length + 1).fill(0);
    counts[0] = 50; // ≤10 ms
    counts[3] = 50; // 50–100 ms
    expect(quantileFromBuckets(counts, 0.5)).toBeCloseTo(0.01, 5);
    expect(quantileFromBuckets(counts, 0.95)).toBeGreaterThan(0.05);
    expect(quantileFromBuckets(counts, 0.95)).toBeLessThanOrEqual(0.1);
    expect(quantileFromBuckets(new Array(11).fill(0), 0.5)).toBeNull();
    recordRequest(0.2, 500);
    expect(windowSummary().errorRate5xx).toBeGreaterThan(0);
  });
});
