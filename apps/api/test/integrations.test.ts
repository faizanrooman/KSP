import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { guardedLookup, isRestrictedIp, validateBaseUrl, type EgressPolicy } from '../src/integrations/egress.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cctns');
const fixture = (f: string) => readFileSync(join(FIX, f), 'utf8');

let app: FastifyInstance;
let stub: http.Server;
let base = '';
const hits: Record<string, number> = {};
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const ALLOW = process.env.INTEGRATION_EGRESS_ALLOW;

beforeAll(async () => {
  app = await evidenceTestSetup();
  // Local stub of the ASSUMED upstream contract, serving the JSON contract fixtures.
  stub = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const [, mode, ...rest] = url.split('?')[0]!.split('/');
    const path = rest.join('/');
    hits[mode ?? ''] = (hits[mode ?? ''] ?? 0) + 1;
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (mode === 'slow') return void setTimeout(() => send(200, fixture('health.json')), 3000);
    if (mode === 'err') return send(503, '{"error":"maintenance"}');
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return void res.end();
    }
    if (mode === 'auth' && req.headers.authorization !== 'Bearer stub-token-123') return send(401, '{"error":"unauthorized"}');
    if (path === 'health') return send(200, fixture('health.json'));
    if (mode === 'html') return send(200, '<html>not json</html>');
    if (path === 'firs/PS-CUB/2026/0501') return send(200, mode === 'mismatch' ? fixture('fir-schema-mismatch.json') : fixture('fir-cubbonpark-2026-0501.json'));
    return send(404, '{"error":"not found"}');
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  process.env.INTEGRATION_EGRESS_ALLOW = '127.0.0.1';
  process.env.KSP_SECRET_STUB_CCTNS = 'stub-token-123';
});

afterAll(async () => {
  if (ALLOW === undefined) delete process.env.INTEGRATION_EGRESS_ALLOW;
  else process.env.INTEGRATION_EGRESS_ALLOW = ALLOW;
  delete process.env.KSP_SECRET_STUB_CCTNS;
  await new Promise((r) => stub.close(r));
  await evidenceTestTeardown();
  await closeApp();
});

let seq = 0;
async function createSystem(body: Record<string, unknown>) {
  const admin = await as('admin');
  const r = await admin.post('/api/v1/integrations/systems', { code: `sys-${Date.now().toString(36)}-${++seq}`, name: 'Test system', systemType: 'CCTNS', ...body });
  expect(r.status, r.raw).toBe(201);
  return r.body as { id: string; verified: boolean; verificationStatus: string };
}
const cfg = (extra: Record<string, unknown> = {}) => ({ stationCodeMap: { 'PS-CUB': 'ps_cubbonpark' }, timeoutMs: 400, retries: 1, ...extra });

describe('integration systems admin', () => {
  it('requires integrations:manage (401/403)', async () => {
    expect((await new Agent(app).get('/api/v1/integrations/systems')).status).toBe(401);
    expect((await (await as('io.meera')).get('/api/v1/integrations/systems')).status).toBe(403);
    expect((await (await as('io.meera')).post('/api/v1/integrations/systems', { code: 'x1', name: 'Valid name', systemType: 'CCTNS', adapter: 'fixture' })).status).toBe(403);
  });

  it('creates systems disabled and UNVERIFIED; fixture systems are labelled FIXTURE and never verified', async () => {
    const s = await createSystem({ adapter: 'fixture' });
    expect(s.verified).toBe(false);
    expect(s.verificationStatus).toBe('FIXTURE');
    const admin = await as('admin');
    const t = await admin.post(`/api/v1/integrations/systems/${s.id}/test`, { probe: { stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' } });
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(true);
    expect(t.body.verified).toBe(false);
    expect(t.body.note).toMatch(/FIXTURE/);
    const log = await admin.get(`/api/v1/integrations/systems/${s.id}/log`);
    expect(log.body.items[0]).toMatchObject({ operation: 'CONTRACT_TEST', status: 'SUCCESS' });
    expect((await admin.post('/api/v1/integrations/systems', { code: 'bad-cfg', name: 'x', systemType: 'CCTNS', adapter: 'fixture', config: { evil: true } })).status).toBe(400);
    expect((await admin.post('/api/v1/integrations/systems', { code: 'no-url', name: 'x', systemType: 'CCTNS', adapter: 'http-json' })).status).toBe(400);
  });
});

describe('FIR import via the fixture adapter', () => {
  let sysId: string;
  beforeAll(async () => {
    sysId = (await createSystem({ adapter: 'fixture' })).id;
  });

  it('refuses imports from disabled systems and shows enabled sources to case managers', async () => {
    const meera = await as('io.meera');
    expect((await meera.post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' })).status).toBe(422);
    expect((await (await as('admin')).post(`/api/v1/integrations/systems/${sysId}/enable`)).status).toBe(200);
    const src = await meera.get('/api/v1/integrations/systems/fir-sources');
    expect(src.body.items.find((s: { id: string }) => s.id === sysId)).toMatchObject({ verified: false, verificationStatus: 'FIXTURE' });
  });

  it('imports (creates then refreshes) a FIR with source CCTNS, sync log and INTEGRATION_SYNC audit', async () => {
    const meera = await as('io.meera');
    const body = { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' };
    const r = await meera.post('/api/v1/firs/import', body);
    expect(r.status, r.raw).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.systemVerified).toBe(false);
    expect(r.body.fir).toMatchObject({ firNumber: '0142', firYear: 2026, source: 'CCTNS', externalRef: 'FIXTURE-CCTNS-CUB-2026-0142', status: 'UNDER_INVESTIGATION' });
    expect(r.body.fir.actsSections).toEqual(['BNS 303(2)', 'BNS 115(2)']);
    const again = await meera.post('/api/v1/firs/import', body);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.fir.id).toBe(r.body.fir.id);
    const audit = await app.db.selectFrom('audit_events').select(['details']).where('action', '=', 'INTEGRATION_SYNC').where('resource_id', '=', r.body.fir.id).execute();
    expect(audit).toHaveLength(2);
    const log = await app.db.selectFrom('integration_sync_log').select(['status', 'operation']).where('system_id', '=', sysId).where('operation', '=', 'FIR_IMPORT').execute();
    expect(log.filter((l) => l.status === 'SUCCESS')).toHaveLength(2);
  });

  it('maps not-found, out-of-jurisdiction and simulated failures', async () => {
    const meera = await as('io.meera');
    const nf = await meera.post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '9999' });
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('INTEGRATION_NOT_FOUND');
    expect((await meera.post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_nazarbad', year: 2026, firNumber: '0007' })).status).toBe(404);
    expect((await (await as('fa.naveen')).post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' })).status).toBe(403);
    const admin = await as('admin');
    await admin.patch(`/api/v1/integrations/systems/${sysId}`, { config: { fixtureMode: 'down' } });
    const down = await meera.post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' });
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('INTEGRATION_UPSTREAM_ERROR');
    await admin.patch(`/api/v1/integrations/systems/${sysId}`, { config: { fixtureMode: 'mismatch' } });
    const mm = await meera.post('/api/v1/firs/import', { systemId: sysId, stationCode: 'ps_cubbonpark', year: 2026, firNumber: '0142' });
    expect(mm.body.error.code).toBe('INTEGRATION_CONTRACT_MISMATCH');
    const fails = await app.db.selectFrom('integration_sync_log').select(['error']).where('system_id', '=', sysId).where('status', '=', 'FAILURE').execute();
    expect(fails.length).toBeGreaterThanOrEqual(3);
  });
});

describe('http-json adapter against a local stub server (contract fixtures)', () => {
  it('passes a live contract test against the stub -> VERIFIED; connection changes reset verification', async () => {
    const s = await createSystem({ adapter: 'http-json', baseUrl: `${base}/ok`, config: cfg() });
    expect(s.verificationStatus).toBe('UNVERIFIED');
    const admin = await as('admin');
    const health = await admin.post(`/api/v1/integrations/systems/${s.id}/test`);
    expect(health.body).toMatchObject({ ok: true, verified: false }); // health alone never verifies
    const t = await admin.post(`/api/v1/integrations/systems/${s.id}/test`, { probe: { stationCode: 'PS-CUB', year: 2026, firNumber: '0501' } });
    expect(t.body, JSON.stringify(t.body)).toMatchObject({ ok: true, verified: true, verificationStatus: 'VERIFIED' });
    expect((await app.db.selectFrom('audit_events').select('seq').where('action', '=', 'INTEGRATION_VERIFIED').where('resource_id', '=', s.id).execute()).length).toBe(1);
    const upd = await admin.patch(`/api/v1/integrations/systems/${s.id}`, { baseUrl: `${base}/ok/` });
    expect(upd.body.verified).toBe(false);

    // Import through the http-json adapter.
    await admin.post(`/api/v1/integrations/systems/${s.id}/enable`);
    const imp = await (await as('io.meera')).post('/api/v1/firs/import', { systemId: s.id, stationCode: 'PS-CUB', year: 2026, firNumber: '0501' });
    expect(imp.status, imp.raw).toBe(201);
    expect(imp.body.fir).toMatchObject({ firNumber: '0501', externalRef: 'STUB-CCTNS-CUB-2026-0501', orgUnit: { code: 'ps_cubbonpark' } });
  });

  it('maps timeout, 5xx (with retries), schema mismatch, non-JSON, upstream 401 and redirects to errors + sync log', async () => {
    const admin = await as('admin');
    const run = async (mode: string, extra: Record<string, unknown> = {}, sysExtra: Record<string, unknown> = {}) => {
      const s = await createSystem({ adapter: 'http-json', baseUrl: `${base}/${mode}`, config: cfg(extra), ...sysExtra });
      const r = await admin.post(`/api/v1/integrations/systems/${s.id}/test`, { probe: { stationCode: 'PS-CUB', year: 2026, firNumber: '0501' } });
      const log = await app.db.selectFrom('integration_sync_log').select(['status', 'error', 'summary']).where('system_id', '=', s.id).executeTakeFirstOrThrow();
      expect(log.status).toBe('FAILURE');
      expect(r.body.verified).toBe(false);
      return r.body.errorCode as string;
    };
    expect(await run('slow', { retries: 0, timeoutMs: 300 })).toBe('TIMEOUT');
    const before = hits.err ?? 0;
    expect(await run('err', { retries: 2 })).toBe('UPSTREAM_ERROR');
    expect((hits.err ?? 0) - before).toBe(3); // 1 + 2 retries
    expect(await run('mismatch')).toBe('CONTRACT_MISMATCH');
    expect(await run('html')).toBe('CONTRACT_MISMATCH'); // health OK, FIR body is not JSON
    expect(await run('auth')).toBe('UNAUTHORIZED'); // no credentials sent -> upstream 401
    expect(await run('redirect')).toBe('UPSTREAM_ERROR');
  });

  it('sends bearer credentials from the secret reference (never stored in the DB)', async () => {
    const admin = await as('admin');
    const s = await createSystem({ adapter: 'http-json', baseUrl: `${base}/auth`, config: cfg({ authType: 'bearer' }), credentialsRef: 'STUB_CCTNS' });
    const d = await admin.get(`/api/v1/integrations/systems/${s.id}`);
    expect(d.body.credentialsPresent).toBe(true);
    expect(JSON.stringify(d.body)).not.toContain('stub-token-123');
    const t = await admin.post(`/api/v1/integrations/systems/${s.id}/test`, { probe: { stationCode: 'PS-CUB', year: 2026, firNumber: '0501' } });
    expect(t.body.ok).toBe(true);
    const wrong = await createSystem({ adapter: 'http-json', baseUrl: `${base}/auth`, config: cfg({ authType: 'bearer' }), credentialsRef: 'MISSING_SECRET' });
    expect((await admin.post(`/api/v1/integrations/systems/${wrong.id}/test`)).body.errorCode).toBe('NOT_CONFIGURED');
    const row = await app.db.selectFrom('integration_systems').select(sql<string>`row_to_json(integration_systems)::text`.as('j')).where('id', '=', s.id).executeTakeFirstOrThrow();
    expect(row.j).not.toContain('stub-token-123');
  });
});

describe('SSRF guard', () => {
  const dev: EgressPolicy = { production: false, allowHosts: [], allowCidrs: [] };
  const prod: EgressPolicy = { production: true, allowHosts: [], allowCidrs: [] };

  it('classifies restricted addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) expect(isRestrictedIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '164.100.1.1', '2606:4700::1111']) expect(isRestrictedIp(ip), ip).toBe(false);
  });

  it('validates base URLs (https in production, no credentials, no private/metadata destinations)', () => {
    expect(() => validateBaseUrl('http://cctns.example.gov.in/api', prod)).toThrow(/https/);
    expect(validateBaseUrl('https://cctns.example.gov.in/api', prod).hostname).toBe('cctns.example.gov.in');
    expect(validateBaseUrl('http://cctns.example.gov.in/api', dev).protocol).toBe('http:');
    expect(() => validateBaseUrl('ftp://cctns.example.gov.in', dev)).toThrow();
    expect(() => validateBaseUrl('https://user:pw@cctns.example.gov.in', dev)).toThrow(/credentials/);
    expect(() => validateBaseUrl('https://10.0.0.5/api', dev)).toThrow(/restricted/);
    expect(() => validateBaseUrl('https://[::1]/api', dev)).toThrow(/restricted/);
    expect(() => validateBaseUrl('https://localhost/api', dev)).toThrow(/not permitted/);
    expect(() => validateBaseUrl('https://metadata.google.internal/', dev)).toThrow(/not permitted/);
    // Allow-listing by deployment config permits private hosts, but never the metadata endpoint.
    expect(validateBaseUrl('https://10.0.0.5/api', { ...dev, allowCidrs: ['10.0.0.0/8'] }).hostname).toBe('10.0.0.5');
    expect(() => validateBaseUrl('http://169.254.169.254/latest', { ...dev, allowCidrs: ['169.254.0.0/16'] })).toThrow(/metadata/);
  });

  it('re-checks resolved addresses at connect time (DNS rebinding)', async () => {
    const err = await new Promise<Error | null>((resolve) => guardedLookup(dev)('localhost', {}, (e) => resolve(e)));
    expect(err?.message).toMatch(/restricted/);
    const ok = await new Promise<Error | null>((resolve) => guardedLookup({ ...dev, allowHosts: ['localhost'] })('localhost', {}, (e) => resolve(e)));
    expect(ok).toBeNull();
  });

  it('rejects private destinations through the API unless allow-listed', async () => {
    const admin = await as('admin');
    const bad = await admin.post('/api/v1/integrations/systems', { code: 'ssrf-meta', name: 'x', systemType: 'CCTNS', adapter: 'http-json', baseUrl: 'http://169.254.169.254/latest/meta-data' });
    expect(bad.status).toBe(400);
    const s = await createSystem({ adapter: 'http-json', baseUrl: `${base}/ok`, config: cfg() });
    delete process.env.INTEGRATION_EGRESS_ALLOW;
    try {
      const t = await admin.post(`/api/v1/integrations/systems/${s.id}/test`);
      expect(t.body.errorCode).toBe('BLOCKED_DESTINATION');
      expect((await admin.post('/api/v1/integrations/systems', { code: 'ssrf-10', name: 'x', systemType: 'CCTNS', adapter: 'http-json', baseUrl: 'http://10.0.0.8/' })).status).toBe(400);
    } finally {
      process.env.INTEGRATION_EGRESS_ALLOW = '127.0.0.1';
    }
  });
});
