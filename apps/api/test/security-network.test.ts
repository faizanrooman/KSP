/** Tender §50: the staff application/API is reachable from authorised internal networks only. */
import { afterAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@ksp/core';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  delete process.env.ALLOWED_NETWORKS;
  resetConfigCache();
});

async function appWith(networks: string) {
  process.env.ALLOWED_NETWORKS = networks;
  resetConfigCache();
  const app = await buildApp({ logger: false });
  apps.push(app);
  return app;
}

describe('network allow-list', () => {
  it('rejects staff API calls from outside the allowed networks with 403 and audits it; allowed networks pass through', async () => {
    const app = await appWith('10.20.0.0/16, 2001:db8::/32');
    const outside = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.9', payload: { username: 'io.meera', password: 'x' } });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('NETWORK_NOT_ALLOWED');
    const inside = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.20.5.6', payload: { username: 'io.meera', password: 'x' } });
    expect(inside.statusCode).toBe(401); // reached the login handler (wrong password), not blocked by network
    const v6 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '2001:db8::10' });
    expect(v6.statusCode).toBe(401);
    const { rows } = await app.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='ACCESS_DENIED' AND details->>'reason'='NETWORK_NOT_ALLOWED' AND actor_ip = '203.0.113.9'");
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('keeps the external share portal, media streams and health probes reachable from any network', async () => {
    const app = await appWith('10.20.0.0/16');
    expect((await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    const portal = await app.inject({ method: 'POST', url: '/api/v1/share-portal/open', remoteAddress: '203.0.113.9', payload: { token: 'nope', code: '000000' } });
    expect(portal.statusCode).not.toBe(403);
    expect(portal.json().error?.code).not.toBe('NETWORK_NOT_ALLOWED');
  });

  it('is disabled when ALLOWED_NETWORKS is empty', async () => {
    const app = await appWith('');
    const r = await app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: '203.0.113.9' });
    expect(r.statusCode).toBe(401);
  });
});
