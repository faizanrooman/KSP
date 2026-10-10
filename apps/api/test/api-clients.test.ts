import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { normaliseCidr } from '../src/modules/api-clients/index.js';
import { integrationOfficer } from './admin-helpers.js';

let app: FastifyInstance;
// API clients can only receive rights their creator holds: evidence scopes need an Integration officer, not the admin.
let officerAgent: Agent | undefined;
const officer = async () => (officerAgent ??= (await integrationOfficer()).agent);
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const org: Record<string, string> = {};
export const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });

beforeAll(async () => {
  app = await evidenceTestSetup();
  for (const r of await app.db.selectFrom('org_units').select(['id', 'code']).execute()) org[r.code] = r.id;
});

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const create = async (extra: Record<string, unknown> = {}) => {
  const r = await (await officer()).post('/api/v1/api-clients', { name: 'CCTNS bridge', scopes: ['evidence:read'], orgUnitId: org.ps_cubbonpark, ...extra });
  expect(r.status, r.raw).toBe(201);
  return r.body as { client: { id: string; status: string }; clientId: string; clientSecret: string };
};
const ping = (id: string, secret: string, remoteAddress?: string) =>
  app.inject({ method: 'GET', url: '/api/v1/integration/evidence', headers: basic(id, secret), ...(remoteAddress ? { remoteAddress } : {}) });

describe('API client administration', () => {
  it('requires integrations:manage', async () => {
    expect((await new Agent(app).get('/api/v1/api-clients')).status).toBe(401);
    expect((await (await as('io.meera')).get('/api/v1/api-clients')).status).toBe(403);
    expect((await (await as('io.meera')).post('/api/v1/api-clients', { name: 'Rogue client', scopes: ['evidence:read'], orgUnitId: org.ps_cubbonpark })).status).toBe(403);
  });

  it('refuses scopes the creator does not hold: the System Administrator cannot mint evidence access (audited)', async () => {
    const sysadmin = await as('admin');
    const r = await sysadmin.post('/api/v1/api-clients', { name: 'Evidence via admin', scopes: ['evidence:read'], orgUnitId: org.ps_cubbonpark });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain('evidence:read');
    const denied = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'ACCESS_DENIED').where('resource_type', '=', 'api_client').orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(denied.details).toMatchObject({ scopes: ['evidence:read'] });
    // Widening an existing client is refused the same way.
    const c = await create({ scopes: ['cases:read'] });
    expect((await sysadmin.patch(`/api/v1/api-clients/${c.client.id}`, { scopes: ['cases:read', 'evidence:download_original'] })).status).toBe(403);
  });

  it('restricts scopes to integration scopes and validates IP allow-lists', async () => {
    const admin = await officer();
    expect((await admin.post('/api/v1/api-clients', { name: 'Too powerful', scopes: ['users:manage'], orgUnitId: org.ps_cubbonpark })).status).toBe(400);
    expect((await admin.post('/api/v1/api-clients', { name: 'Bad IPs', scopes: ['evidence:read'], orgUnitId: org.ps_cubbonpark, allowedIps: ['10.0.0.1/8'] })).status).toBe(400);
    expect((await admin.post('/api/v1/api-clients', { name: 'Past expiry', scopes: ['evidence:read'], orgUnitId: org.ps_cubbonpark, expiresAt: '2000-01-01T00:00:00Z' })).status).toBe(400);
    expect(normaliseCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(normaliseCidr('192.168.1.7')).toBe('192.168.1.7/32');
    expect(normaliseCidr('192.168.1.7/24')).toBeNull();
    expect(normaliseCidr('::1')).toBe('::1/128');
    expect(normaliseCidr('not-an-ip')).toBeNull();
  });

  it('shows the secret once, stores only a hash, authenticates, rotates and revokes', async () => {
    const admin = await officer();
    const c = await create();
    expect(c.clientSecret).toMatch(/^ksps_/);
    const row = await app.db.selectFrom('api_clients').select(['secret_hash']).where('id', '=', c.client.id).executeTakeFirstOrThrow();
    expect(row.secret_hash).toMatch(/^\$argon2id\$/);
    expect(row.secret_hash).not.toContain(c.clientSecret);
    const detail = await admin.get(`/api/v1/api-clients/${c.client.id}`);
    expect(JSON.stringify(detail.body)).not.toMatch(/secret_hash|ksps_|argon2/);
    const list = await admin.get('/api/v1/api-clients');
    expect(JSON.stringify(list.body)).not.toMatch(/ksps_|argon2/);
    expect(list.body.availableScopes).toContain('evidence:download_original');

    expect((await ping(c.clientId, c.clientSecret)).statusCode).toBe(200);
    expect((await ping(c.clientId, 'wrong-secret')).statusCode).toBe(401);
    const created = await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', c.client.id).where('action', '=', 'API_CLIENT_CREATED').execute();
    expect(created).toHaveLength(1);

    const rot = await admin.post(`/api/v1/api-clients/${c.client.id}/rotate-secret`);
    expect(rot.status).toBe(200);
    expect(rot.body.clientSecret).not.toBe(c.clientSecret);
    expect((await ping(c.clientId, c.clientSecret)).statusCode).toBe(401);
    expect((await ping(c.clientId, rot.body.clientSecret)).statusCode).toBe(200);

    expect((await admin.post(`/api/v1/api-clients/${c.client.id}/revoke`, { reason: 'x' })).status).toBe(400);
    const rev = await admin.post(`/api/v1/api-clients/${c.client.id}/revoke`, { reason: 'Contract ended' });
    expect(rev.body.status).toBe('REVOKED');
    expect((await ping(c.clientId, rot.body.clientSecret)).statusCode).toBe(401);
    expect((await admin.post(`/api/v1/api-clients/${c.client.id}/revoke`, { reason: 'Contract ended' })).status).toBe(409);
    const revoked = await app.db.selectFrom('audit_events').select('details').where('resource_id', '=', c.client.id).where('action', '=', 'API_CLIENT_REVOKED').execute();
    expect(revoked).toHaveLength(1);
  });

  it('enforces expiry and the IP allow-list', async () => {
    const c = await create({ allowedIps: ['10.20.0.0/16'] });
    expect((await ping(c.clientId, c.clientSecret, '127.0.0.1')).statusCode).toBe(401);
    expect((await ping(c.clientId, c.clientSecret, '10.20.3.4')).statusCode).toBe(200);
    const e = await create();
    await app.db.updateTable('api_clients').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', e.client.id).execute();
    expect((await ping(e.clientId, e.clientSecret)).statusCode).toBe(401);
    expect((await (await officer()).get(`/api/v1/api-clients/${e.client.id}`)).body.status).toBe('EXPIRED');
  });

  it('limits API clients to the integration API', async () => {
    const c = await create({ scopes: ['evidence:read', 'cases:read'] });
    const r = await app.inject({ method: 'GET', url: '/api/v1/evidence', headers: basic(c.clientId, c.clientSecret) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('API_CLIENT_ROUTE_FORBIDDEN');
    expect((await app.inject({ method: 'GET', url: '/api/v1/cases', headers: basic(c.clientId, c.clientSecret) })).statusCode).toBe(403);
  });
});
