/**
 * Residual security findings closed in the completion round: SEC-R7 (generic public readiness), SEC-R8 (API-client
 * Basic auth: uniform timing + verification cache invalidated on rotate/revoke), SEC-R9 (unreviewed AI search
 * needs an AI permission), SEC-R10 (ai_jobs status transitions for ksp_ai), SEC-R11 (pinned decision: snapshot
 * from the original needs only evidence:snapshot).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@ksp/core';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { apiClientCacheSize } from '../src/lib/api-client-auth.js';

let app: FastifyInstance;
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });

beforeAll(async () => {
  app = await evidenceTestSetup();
});
afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('SEC-R7 public readiness probe', () => {
  it('returns only ok/fail per check (no backend error text); details are behind system:monitor', async () => {
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready', checks: { database: 'ok', objectStorage: 'ok' } });
    // Failing dependency: a bucket that does not exist → 503 with a generic body.
    const bucket = app.storage.bucket.bind(app.storage);
    (app.storage as { bucket: (k: string) => string }).bucket = () => 'ksp-no-such-bucket-sec-r7';
    try {
      const bad = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(bad.statusCode).toBe(503);
      expect(bad.json()).toEqual({ status: 'degraded', checks: { database: 'ok', objectStorage: 'fail' } });
      expect(bad.body).not.toMatch(/bucket|NotFound|error/i);
    } finally {
      (app.storage as { bucket: typeof bucket }).bucket = bucket;
    }
    expect((await new Agent(app).get('/api/v1/system/health')).status).toBe(401);
    expect((await (await as('io.meera')).get('/api/v1/system/health')).status).toBe(403);
  });
});

describe('SEC-R8 API-client Basic auth', () => {
  const create = async () => {
    const org = await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const r = await (await as('admin')).post('/api/v1/api-clients', { name: 'SEC-R8 client', scopes: ['evidence:read'], orgUnitId: org.id });
    expect(r.status, r.raw).toBe(201);
    return r.body as { client: { id: string }; clientId: string; clientSecret: string };
  };
  const ping = (id: string, secret: string) => app.inject({ method: 'GET', url: '/api/v1/integration/evidence', headers: basic(id, secret) });

  it('unknown client ids take as long as wrong secrets (dummy argon2) — medians within 50 %', async () => {
    const c = await create();
    const t = async (id: string) => { const s = process.hrtime.bigint(); expect((await ping(id, 'wrong-secret-value')).statusCode).toBe(401); return Number(process.hrtime.bigint() - s) / 1e6; };
    await t('nope'); await t(c.clientId);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 12; i++) { known.push(await t(c.clientId)); unknown.push(await t(`ghost-${i}`)); }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    console.log(`[api-client timing] known ${med(known).toFixed(1)} ms, unknown ${med(unknown).toFixed(1)} ms`);
    expect(Math.abs(med(known) - med(unknown)) / Math.min(med(known), med(unknown))).toBeLessThan(0.5);
  });

  it('caches positive verifications but a rotated secret or a revoked client stops working immediately', async () => {
    const c = await create();
    expect((await ping(c.clientId, c.clientSecret)).statusCode).toBe(200);
    const size = apiClientCacheSize();
    expect(size).toBeGreaterThanOrEqual(1);
    // Cached path: many calls are fast (no argon2 each time).
    const s = Date.now();
    for (let i = 0; i < 10; i++) expect((await ping(c.clientId, c.clientSecret)).statusCode).toBe(200);
    console.log(`[api-client cache] 10 cached calls in ${Date.now() - s} ms`);
    const admin = await as('admin');
    const rot = await admin.post(`/api/v1/api-clients/${c.client.id}/rotate-secret`, {});
    expect(rot.status).toBe(200);
    expect((await ping(c.clientId, c.clientSecret)).statusCode).toBe(401);
    expect((await ping(c.clientId, rot.body.clientSecret)).statusCode).toBe(200);
    // A secret_hash change made elsewhere (another replica rotated) also invalidates the cached entry.
    const other = await create();
    expect((await ping(other.clientId, other.clientSecret)).statusCode).toBe(200);
    await app.db.updateTable('api_clients').set({ secret_hash: '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }).where('id', '=', other.client.id).execute();
    expect((await ping(other.clientId, other.clientSecret)).statusCode).toBe(401);
    // Revocation: checked on every request (DB row), cache evicted.
    expect((await admin.post(`/api/v1/api-clients/${c.client.id}/revoke`, { reason: 'SEC-R8 test revoke' })).status).toBe(200);
    expect((await ping(c.clientId, rot.body.clientSecret)).statusCode).toBe(401);
  });
});

describe('SEC-R9 unreviewed AI search', () => {
  it('ai.reviewStatus=ANY_NON_REJECTED requires ai:review or ai:request; APPROVED needs only search:use', async () => {
    const code = `SEARCH_ONLY_${Date.now().toString(36).toUpperCase()}`;
    await app.db.insertInto('roles').values({ code, name: 'Search only (test)', permissions: ['search:use', 'evidence:read'] }).execute();
    const u = await createUser({ role: code, org: 'ps_cubbonpark' });
    const a = await login(u.username);
    expect((await a.post('/api/v1/search/evidence', { ai: { reviewStatus: 'APPROVED' } })).status).toBe(200);
    const denied = await a.post('/api/v1/search/evidence', { ai: { reviewStatus: 'ANY_NON_REJECTED' } });
    expect(denied.status).toBe(403);
    const audit = await app.db.selectFrom('audit_events').select(['action', 'outcome']).where('actor_id', '=', u.id).where('action', '=', 'ACCESS_DENIED').execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect((await (await as('io.meera')).post('/api/v1/search/evidence', { ai: { reviewStatus: 'ANY_NON_REJECTED' } })).status).toBe(200);
  });
});

describe('SEC-R10 ai_jobs status transitions for ksp_ai', () => {
  let aiPool: pg.Pool;
  beforeAll(() => { aiPool = new pg.Pool({ connectionString: loadConfig().DATABASE_AI_URL, max: 2 }); });
  afterAll(async () => { await aiPool.end(); });

  const state = async (pool: pg.Pool, id: string, to: string) => {
    try {
      await pool.query('UPDATE ai_jobs SET status = $2 WHERE id = $1', [id, to]);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERR';
    }
  };

  it('allows QUEUED→RUNNING→terminal only; cannot revive CANCELLED/COMPLETED/FAILED or re-queue', async () => {
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera'), durationSeconds: 1 });
    const mk = async (status: string) => (await app.db.insertInto('ai_jobs').values({
      evidence_id: ev.id, requested_by: await userId('io.meera'), tasks: ['OBJECT_DETECTION'], status, model_ids: [], input: JSON.stringify({ orgUnitId: ev.orgUnitId }),
    }).returning('id').executeTakeFirstOrThrow()).id;
    const j = await mk('QUEUED');
    expect(await state(aiPool, j, 'COMPLETED')).toBe('42501');
    expect(await state(aiPool, j, 'RUNNING')).toBeNull();
    expect(await state(aiPool, j, 'QUEUED')).toBe('42501');
    expect(await state(aiPool, j, 'COMPLETED')).toBeNull();
    for (const back of ['RUNNING', 'QUEUED', 'FAILED']) expect(await state(aiPool, j, back)).toBe('42501');
    const c = await mk('CANCELLED');
    for (const back of ['RUNNING', 'QUEUED', 'COMPLETED']) expect(await state(aiPool, c, back)).toBe('42501');
    const f = await mk('RUNNING');
    expect(await state(aiPool, f, 'FAILED')).toBeNull();
    expect(await state(aiPool, f, 'RUNNING')).toBe('42501');
    // Progress/heartbeat updates without a status change stay allowed.
    await aiPool.query('UPDATE ai_jobs SET progress = 0.5 WHERE id = $1', [f]);
    // The application role (cancel / re-analysis flows) is not restricted by the guard.
    await app.db.updateTable('ai_jobs').set({ status: 'QUEUED' }).where('id', '=', c).execute();
  });
});

describe('OPS-9 AI worker config without key-shaped placeholders', () => {
  it('KSP_SERVICE=ksp-ai-worker loads without JWT/signing/media/data-encryption secrets; other services still require them', async () => {
    const { AI_WORKER_UNUSED_SECRETS } = await import('@ksp/core');
    loadConfig(); // ensure .env.test is in process.env
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of [...AI_WORKER_UNUSED_SECRETS, 'DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEYS']) delete env[k];
    expect(() => loadConfig({ ...env, KSP_SERVICE: 'ksp-api' })).toThrow(/JWT_PRIVATE_KEY/);
    const cfg = loadConfig({ ...env, KSP_SERVICE: 'ksp-ai-worker' });
    expect(cfg.MEDIA_TOKEN_SECRET).toHaveLength(64);
    expect(cfg.MEDIA_TOKEN_SECRET).not.toBe(loadConfig().MEDIA_TOKEN_SECRET);
    expect(cfg.DATA_ENCRYPTION_KEY).toBeUndefined();
  });
});

describe('SEC-R11 (decision: keep) snapshot from the original', () => {
  it('evidence:snapshot alone permits a still from the original — no evidence:download_original needed', async () => {
    // Behaviour is exercised end-to-end in media.test.ts ("extracts the exact frame (proxy and original)") by io.meera,
    // whose role deliberately lacks evidence:download_original. Pin that premise here so a role change that would
    // silently turn that test into a download_original test is caught. See docs/AUTHORIZATION.md (SEC-R11).
    const { DEFAULT_ROLES } = await import('@ksp/shared');
    const io = (DEFAULT_ROLES as unknown as Array<{ code: string; permissions: readonly string[] }>).find((r) => r.code === 'INVESTIGATING_OFFICER')!;
    expect(io.permissions).toContain('evidence:snapshot');
    expect(io.permissions).not.toContain('evidence:download_original');
    const meeraPerms = (await (await as('io.meera')).get('/api/v1/auth/me')).raw;
    expect(meeraPerms).toContain('evidence:snapshot');
    expect(meeraPerms).not.toContain('evidence:download_original');
  });
});
