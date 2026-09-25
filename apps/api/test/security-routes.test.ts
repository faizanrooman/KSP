/**
 * Automated route-level authorization sweep (security testing). Enumerates EVERY registered route (via the
 * `routeRegistry` populated by an onRoute hook in buildApp) and asserts:
 *   1. the set of public routes equals a reviewed allow-list (a new public route fails this test until reviewed);
 *   2. every non-public route answers 401 without credentials;
 *   3. every state-changing route rejects cookie auth without the CSRF header (403 CSRF_FAILED);
 *   4. API_CLIENT principals are refused outside /integration/* and /media/download/*.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashSecret, randomToken } from '@ksp/core';
import { CSRF_COOKIE } from '@ksp/shared';
import type { FastifyInstance } from 'fastify';
import { closeApp, getApp, login, type Agent } from './helpers.js';

afterAll(closeApp);

/** Reviewed public routes. Each is authenticated by other means (token / code / login itself) or is harmless. */
export const PUBLIC_ALLOW_LIST = new Set<string>([
  // Pre-authentication endpoints (rate limited; generic errors).
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/verify', // requires a 5-minute typ=mfa JWT
  'POST /api/v1/auth/refresh', // requires an opaque rotating refresh token (reuse => family revoked)
  // HMAC media tokens (core signMediaToken) bound to evidence + scope (+ref); USER tokens re-check the session row,
  // SHARE tokens re-check the share, API_CLIENT tokens re-check the client and its IP allow-list.
  'GET /api/v1/media/stream/:evidenceId/*',
  'GET /api/v1/media/image/:derivativeId',
  'GET /api/v1/media/download/:evidenceId',
  'GET /api/v1/ai/crops/:detectionId', // USER tokens only, ref = ai:<detectionId>
  'GET /api/v1/exports/:id/package', // USER tokens only, scope export, ref = export id
  // External share portal: link token + access code => X-Share-Session HMAC header (domain-separated key).
  'POST /api/v1/share-portal/open',
  'GET /api/v1/share-portal/session',
  'GET /api/v1/share-portal/items/:evidenceId/playback',
  'GET /api/v1/share-portal/items/:evidenceId/download-link',
  'GET /api/v1/share-portal/items/:evidenceId/print',
  'GET /api/v1/share-portal/download/:evidenceId',
]);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let app: FastifyInstance;
let routes: Array<{ method: string; url: string; public: boolean }>;

/** Concrete URL for a route pattern: params -> random UUID, wildcard -> a harmless segment. */
function concrete(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, () => randomUUID()).replace(/\*$/, 'x');
}

beforeAll(async () => {
  app = await getApp();
  await app.ready();
  routes = app.routeRegistry.filter((r) => r.url.startsWith('/api/v1') && r.method !== 'HEAD' && r.method !== 'OPTIONS');
});

describe('route sweep', () => {
  it('discovers a non-trivial number of routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('public routes match the reviewed allow-list exactly', () => {
    const actual = routes.filter((r) => r.public).map((r) => `${r.method} ${r.url}`).sort();
    console.log('PUBLIC ROUTES:\n' + actual.join('\n'));
    expect(actual).toEqual([...PUBLIC_ALLOW_LIST].sort());
  });

  it('every non-public route answers 401 without credentials', async () => {
    const failures: string[] = [];
    for (const r of routes.filter((x) => !x.public)) {
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url), payload: UNSAFE.has(r.method) ? {} : undefined });
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it('every state-changing route rejects cookie auth without the CSRF header', async () => {
    const agent: Agent = await login('io.meera');
    const cookie = [...agent.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const failures: string[] = [];
    for (const r of routes.filter((x) => UNSAFE.has(x.method))) {
      const res = await app.inject({ method: r.method as 'POST', url: concrete(r.url), headers: { cookie }, payload: {} });
      const code = (res.json() as { error?: { code?: string } }).error?.code;
      if (res.statusCode !== 403 || code !== 'CSRF_FAILED') failures.push(`${r.method} ${r.url} -> ${res.statusCode} ${code}`);
    }
    expect(failures).toEqual([]);
    // Wrong header value and hostile Origin are refused too.
    const csrf = agent.cookies.get(CSRF_COOKIE)!;
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': `${csrf}x` }, payload: {} });
    expect(wrong.statusCode).toBe(403);
    const hostile = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://evil.example' }, payload: {} });
    expect(hostile.statusCode).toBe(403);
  });

  it('API clients are refused outside /integration/* and /media/download/*', async () => {
    const org = await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const clientId = `sweep_${randomToken(6)}`;
    const secret = randomToken(24);
    await app.db.insertInto('api_clients').values({ name: 'route sweep', client_id: clientId, secret_hash: await hashSecret(secret), scopes: ['evidence:read', 'cases:read'], org_unit_id: org.id }).execute();
    const authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    const failures: string[] = [];
    for (const r of routes) {
      if (r.url.startsWith('/api/v1/integration/') || r.url.startsWith('/api/v1/media/download/')) continue;
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url), headers: { authorization }, payload: UNSAFE.has(r.method) ? {} : undefined });
      const code = (res.json() as { error?: { code?: string } }).error?.code;
      if (res.statusCode !== 403 || code !== 'API_CLIENT_ROUTE_FORBIDDEN') failures.push(`${r.method} ${r.url} -> ${res.statusCode} ${code}`);
    }
    expect(failures).toEqual([]);
  });

  it('URL variants do not bypass the API-client route restriction or authentication', async () => {
    for (const url of ['/api/v1/integration/../users', '/api/v1/integration/%2e%2e/users', '//api/v1/users', '/api/v1//users', '/API/v1/users', '/api/v1/users/']) {
      const res = await app.inject({ method: 'GET', url });
      expect([401, 404], `${url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
  });
});
