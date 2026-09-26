/**
 * Production-configured build (security round 2): the same buildApp() with NODE_ENV=production and
 * COOKIE_SECURE=true (the config loader refuses production without it), against the test database. Proves the
 * limits that are relaxed under NODE_ENV=test really trigger (429), and the production-only protections:
 * HSTS, Secure cookies, OpenAPI docs behind authentication, no stack traces / internal messages on 500.
 * No production code path is weakened for this: the test flips the environment, not the code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig, repoRoot, resetConfigCache } from '@ksp/core';
import { DEV_PASSWORD } from '@ksp/core/dev-seed';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
const saved = { NODE_ENV: process.env.NODE_ENV, COOKIE_SECURE: process.env.COOKIE_SECURE, KSP_ENV_FILE: process.env.KSP_ENV_FILE };
let ipSeq = 0;
const freshIp = () => `10.99.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

beforeAll(async () => {
  loadConfig(); // loads .env.test into process.env (test DB + buckets) before switching mode
  process.env.KSP_ENV_FILE = resolve(repoRoot(), '.env.test');
  process.env.NODE_ENV = 'production';
  process.env.COOKIE_SECURE = 'true';
  resetConfigCache();
  expect(loadConfig().NODE_ENV).toBe('production');
  app = await buildApp({ logger: false });
  // A route that fails with an internal error carrying sensitive text (registered before ready()).
  app.get('/api/v1/__test_boom', { config: { public: true } }, async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 /srv/ksp/secret/path.ts');
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
});

const hit = (opts: InjectOptions) => app.inject(opts);

async function hammer(n: number, opts: () => InjectOptions): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await hit(opts())).statusCode);
  return out;
}

async function loginCookies(ip: string): Promise<{ cookie: string; csrf: string }> {
  const r = await hit({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username: 'io.meera', password: DEV_PASSWORD } });
  expect(r.statusCode).toBe(200);
  const jar = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return { cookie: jar, csrf: r.cookies.find((c) => c.name === 'ksp_csrf')!.value };
}

describe('rate limits (production limits)', () => {
  it('login: 10/min per IP, then 429', async () => {
    const ip = freshIp();
    const s = await hammer(12, () => ({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username: 'nobody_rl', password: 'x' } }));
    expect(s.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(s.slice(10)).toEqual([429, 429]);
    const other = await hit({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: freshIp(), payload: { username: 'nobody_rl', password: 'x' } });
    expect(other.statusCode).toBe(401); // per-IP bucket
  });

  it('MFA verify: 10/min per IP, then 429', async () => {
    const ip = freshIp();
    const s = await hammer(11, () => ({ method: 'POST', url: '/api/v1/auth/mfa/verify', remoteAddress: ip, payload: { mfaToken: 'x'.repeat(40), code: '123456' } }));
    expect(s.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(s[10]).toBe(429);
  });

  it('share-portal open: 10/min per IP, then 429', async () => {
    const ip = freshIp();
    const s = await hammer(11, () => ({ method: 'POST', url: '/api/v1/share-portal/open', remoteAddress: ip, payload: { token: 'x'.repeat(43), code: '12345678' } }));
    expect(s.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(s[10]).toBe(429);
  });

  it('password change: 10/min, then 429', async () => {
    const ip = freshIp();
    const { cookie, csrf } = await loginCookies(ip);
    const s = await hammer(11, () => ({ method: 'POST', url: '/api/v1/auth/password/change', remoteAddress: ip, headers: { cookie, 'x-csrf-token': csrf }, payload: { currentPassword: 'wrong-current', newPassword: 'whatever-New-1!' } }));
    expect(s.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(s[10]).toBe(429);
  });

  it('upload initiation: 120/min per IP, then 429 (limit added in round 2)', async () => {
    const ip = freshIp();
    const { cookie, csrf } = await loginCookies(ip);
    // Invalid bodies (400) still count: the limiter runs before validation, so no staging objects are created.
    const s = await hammer(121, () => ({ method: 'POST', url: '/api/v1/uploads', remoteAddress: ip, headers: { cookie, 'x-csrf-token': csrf }, payload: {} }));
    expect(s.slice(0, 120).every((c) => c === 400)).toBe(true);
    expect(s[120]).toBe(429);
  });

  it('the 429 body is the standard error envelope', async () => {
    const ip = freshIp();
    const s = await hammer(11, () => ({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username: 'x', password: 'y' } }));
    expect(s[10]).toBe(429);
    const r = await hit({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { username: 'x', password: 'y' } });
    expect(r.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('production headers, cookies and error hygiene', () => {
  it('HSTS on every response', async () => {
    const r = await hit({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: freshIp() });
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000; includeSubDomains/);
  });

  it('auth cookies are Secure + HttpOnly (CSRF cookie Secure, readable by JS by design) + SameSite=Strict', async () => {
    const r = await hit({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: freshIp(), payload: { username: 'io.meera', password: DEV_PASSWORD } });
    expect(r.statusCode).toBe(200);
    const byName = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
    for (const n of ['ksp_at', 'ksp_rt', 'ksp_csrf']) {
      expect(byName[n]?.secure, n).toBe(true);
      expect(byName[n]?.sameSite, n).toBe('Strict');
    }
    expect(byName.ksp_at!.httpOnly).toBe(true);
    expect(byName.ksp_rt!.httpOnly).toBe(true);
    expect(byName.ksp_rt!.path).toBe('/api/v1/auth');
  });

  it('OpenAPI docs require authentication in production', async () => {
    const ip = freshIp();
    for (const url of ['/api/docs', '/api/docs/json', '/api/docs/static/index.html']) {
      expect((await hit({ method: 'GET', url, remoteAddress: ip })).statusCode, url).toBe(401);
    }
    const { cookie } = await loginCookies(ip);
    expect((await hit({ method: 'GET', url: '/api/docs/json', remoteAddress: ip, headers: { cookie } })).statusCode).toBe(200);
  });

  it('500s carry no stack trace, no internal message, no paths', async () => {
    const r = await hit({ method: 'GET', url: '/api/v1/__test_boom', remoteAddress: freshIp() });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error', requestId: expect.any(String) } });
    expect(r.body).not.toMatch(/ECONNREFUSED|secret|\.ts|stack/);
  });
});
