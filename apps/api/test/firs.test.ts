import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';

let app: FastifyInstance;
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const org: Record<string, string> = {};
let firId: string;
const YEAR = 2031; // isolated from fixture-import years

beforeAll(async () => {
  app = await evidenceTestSetup();
  for (const r of await app.db.selectFrom('org_units').select(['id', 'code']).execute()) org[r.code] = r.id;
});

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const firBody = (n: string, extra: Record<string, unknown> = {}) => ({
  firNumber: n, firYear: YEAR, orgUnitId: org.ps_cubbonpark, registeredAt: `${YEAR}-02-01T10:00:00Z`,
  actsSections: ['BNS 303(2)', 'BNS 115(2)'], complainant: 'Test complainant', briefFacts: 'Phone theft at bus stop', ...extra,
});

describe('FIR management', () => {
  it('enforces authentication, permission and jurisdiction', async () => {
    expect((await new Agent(app).get('/api/v1/firs')).status).toBe(401);
    expect((await (await as('fo.ravi')).get('/api/v1/firs')).status).toBe(403);
    expect((await (await as('fa.naveen')).post('/api/v1/firs', firBody('0001'))).status).toBe(403);
    expect((await (await as('io.mysuru')).post('/api/v1/firs', firBody('0001'))).status).toBe(404);
  });

  it('creates a FIR, rejects duplicates (station, year, number) with 409', async () => {
    const meera = await as('io.meera');
    const r = await meera.post('/api/v1/firs', firBody('0001'));
    expect(r.status, r.raw).toBe(201);
    firId = r.body.id;
    expect(r.body).toMatchObject({ firNumber: '0001', firYear: YEAR, displayNumber: `0001/${YEAR}`, source: 'MANUAL', status: 'REGISTERED' });
    expect((await meera.post('/api/v1/firs', firBody('0001'))).status).toBe(409);
    // Same number at another station is fine.
    expect((await (await as('io.arjun')).post('/api/v1/firs', firBody('0001', { orgUnitId: org.ps_indiranagar }))).status).toBe(201);
    expect((await meera.post('/api/v1/firs', firBody('0002', { occurredFrom: '2031-01-02T00:00:00Z', occurredTo: '2031-01-01T00:00:00Z' }))).status).toBe(400);
    expect((await meera.post('/api/v1/firs', firBody('bad number!'))).status).toBe(400);
  });

  it('lists with filters and applies jurisdiction to detail', async () => {
    const meera = await as('io.meera');
    const l = await meera.get(`/api/v1/firs?year=${YEAR}&actSection=${encodeURIComponent('303(2)')}&q=theft`);
    expect(l.status).toBe(200);
    expect(l.body.items.map((f: { id: string }) => f.id)).toEqual([firId]);
    expect((await meera.get(`/api/v1/firs?orgUnitId=${org.ps_indiranagar}&year=${YEAR}`)).body.total).toBe(0);
    expect((await meera.get(`/api/v1/firs/${firId}`)).status).toBe(200);
    expect((await (await as('io.arjun')).get(`/api/v1/firs/${firId}`)).status).toBe(404);
    expect((await (await as('sup.kavya')).get(`/api/v1/firs/${firId}`)).status).toBe(200);
  });

  it('updates details and validates status transitions', async () => {
    const meera = await as('io.meera');
    expect((await meera.patch(`/api/v1/firs/${firId}`, { placeOfOccurrence: 'KR Circle bus stop' })).body.placeOfOccurrence).toBe('KR Circle bus stop');
    expect((await (await as('io.arjun')).patch(`/api/v1/firs/${firId}`, { complainant: 'x' })).status).toBe(404);
    expect((await meera.post(`/api/v1/firs/${firId}/status`, { status: 'CHARGESHEETED', reason: 'skip ahead' })).status).toBe(409);
    expect((await meera.post(`/api/v1/firs/${firId}/status`, { status: 'UNDER_INVESTIGATION', reason: 'Investigation started' })).status).toBe(200);
    const d = await meera.get(`/api/v1/firs/${firId}`);
    expect(d.body.status).toBe('UNDER_INVESTIGATION');
    expect(d.body.allowedTransitions).toContain('CHARGESHEETED');
  });

  it('links a case to the FIR and shows it on the FIR detail', async () => {
    const meera = await as('io.meera');
    const c = await meera.post('/api/v1/cases', { title: 'Phone theft investigation', firId });
    expect(c.status, c.raw).toBe(201);
    expect(c.body.fir.id).toBe(firId);
    expect(c.body.orgUnit.id).toBe(org.ps_cubbonpark);
    const d = await meera.get(`/api/v1/firs/${firId}`);
    expect(d.body.cases.map((x: { id: string }) => x.id)).toContain(c.body.id);
    // A FIR outside jurisdiction cannot be attached.
    const other = (await (await as('io.mysuru')).post('/api/v1/firs', firBody('0009', { orgUnitId: org.ps_nazarbad }))).body.id;
    expect((await meera.post('/api/v1/cases', { title: 'Cross-district FIR', firId: other })).status).toBe(404);
  });
});
