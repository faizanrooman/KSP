/** Browser-facing protections: security headers, CORS allow-list, session cookie flags, error hygiene. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEV_PASSWORD } from '@ksp/core/dev-seed';
import { closeApp, getApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterAll(closeApp);

describe('security headers', () => {
  it('sets CSP (frame-ancestors none, no inline script), nosniff and a same-origin CORP', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS: a hostile Origin gets no Access-Control-Allow-Origin; the configured origin does', async () => {
    const hostile = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(hostile.headers['access-control-allow-origin']).toBeUndefined();
    const allowed = app.cfg.CORS_ORIGINS.split(',')[0]!.trim();
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin: allowed, 'access-control-request-method': 'POST' } });
    expect(ok.headers['access-control-allow-origin']).toBe(allowed);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
  });

  it('session cookies are httpOnly + SameSite=Strict; the CSRF cookie is readable by script', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'fo.ravi', password: DEV_PASSWORD } });
    expect(r.statusCode).toBe(200);
    const byName = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
    for (const [name, c] of Object.entries(byName)) {
      expect(String(c.sameSite).toLowerCase(), name).toBe('strict');
      if (name !== 'ksp_csrf') expect(c.httpOnly, name).toBe(true);
    }
    expect(byName.ksp_csrf?.httpOnly).toBeFalsy();
  });

  it('errors carry no stack traces or internal paths', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"username":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at \w+ \(|node_modules|\/home\/|\.ts:\d+/);
    // Unknown routes under /api answer 401 before routing (no route-existence oracle for anonymous callers).
    const nf = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(nf.statusCode).toBe(401);
    expect(nf.body).not.toMatch(/node_modules|\/home\//);
  });
});
