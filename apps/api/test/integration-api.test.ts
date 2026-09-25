import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';

let app: FastifyInstance;
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const org: Record<string, string> = {};
const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });
let A: CreatedEvidence; // Cubbon Park, officer fo.ravi
let B: CreatedEvidence; // Indiranagar
let client: { id: string; clientId: string; secret: string };
let readOnly: { id: string; clientId: string; secret: string };
let caseNumber: string;
const FIR_YEAR = 2033;

async function mkClient(scopes: string[], extra: Record<string, unknown> = {}) {
  const r = await (await as('admin')).post('/api/v1/api-clients', { name: `Client ${scopes.join('+')}`, scopes, orgUnitId: org.ps_cubbonpark, ...extra });
  expect(r.status, r.raw).toBe(201);
  return { id: r.body.client.id as string, clientId: r.body.clientId as string, secret: r.body.clientSecret as string };
}
const call = (c: { clientId: string; secret: string }, url: string) => app.inject({ method: 'GET', url: `/api/v1/integration${url}`, headers: basic(c.clientId, c.secret) });

beforeAll(async () => {
  app = await evidenceTestSetup();
  for (const r of await app.db.selectFrom('org_units').select(['id', 'code']).execute()) org[r.code] = r.id;
  const ravi = await userId('fo.ravi');
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: ravi, officerId: ravi, title: 'Integration API clip A', recordedAt: new Date('2026-04-01T10:00:00Z') });
  B = await createRegisteredEvidence({ orgCode: 'ps_indiranagar', uploadedBy: await userId('io.arjun'), title: 'Integration API clip B' });
  client = await mkClient(['evidence:read', 'evidence:download_original', 'cases:read']);
  readOnly = await mkClient(['evidence:read']);
  const meera = await as('io.meera');
  const fir = await meera.post('/api/v1/firs', { firNumber: '0321', firYear: FIR_YEAR, orgUnitId: org.ps_cubbonpark, registeredAt: `${FIR_YEAR}-01-05T08:00:00Z` });
  const c = await meera.post('/api/v1/cases', { title: 'Integration API case', firId: fir.body.id });
  caseNumber = c.body.caseNumber;
  await meera.post(`/api/v1/cases/${c.body.id}/evidence`, { evidenceIds: [A.id] });
}, 180_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('integration evidence search', () => {
  it('requires authentication and the evidence:read scope', async () => {
    expect((await new Agent(app).get('/api/v1/integration/evidence')).status).toBe(401);
    const none = await mkClient(['cases:read']);
    expect((await call(none, '/evidence')).statusCode).toBe(403);
  });

  it('limits results to the client jurisdiction and supports FIR / case / station / officer / number / date filters', async () => {
    // Other suites share the test DB (e.g. thousands of synthetic search rows): look items up by number.
    const byNumber = async (n: string) => (await call(client, `/evidence?evidenceNumber=${encodeURIComponent(n)}`)).json().items.map((i: { id: string }) => i.id);
    expect(await byNumber(A.evidenceNumber)).toContain(A.id);
    expect(await byNumber(B.evidenceNumber)).not.toContain(B.id);
    const ids1 = async (q: string) => (await call(client, `/evidence?${q}`)).json().items.map((i: { id: string }) => i.id);
    expect(await ids1(`firStation=ps_cubbonpark&firYear=${FIR_YEAR}&firNumber=321`)).toEqual([A.id]);
    expect(await ids1(`caseNumber=${caseNumber}`)).toEqual([A.id]);
    expect(await ids1(`evidenceNumber=${A.evidenceNumber}`)).toEqual([A.id]);
    expect(await ids1('officerBadge=KSP-FO-1001&recordedFrom=2026-03-31T00:00:00Z&recordedTo=2026-04-02T00:00:00Z')).toContain(A.id);
    expect(await ids1(`evidenceNumber=${B.evidenceNumber}`)).toEqual([]);
    expect(await ids1('station=ps_indiranagar')).toEqual([]);
    const all = (await call(client, `/evidence?evidenceNumber=${encodeURIComponent(A.evidenceNumber)}`)).json();
    const item = all.items.find((i: { id: string }) => i.id === A.id);
    expect(item.hashes.sha256).toBe(A.sha256);
    expect(item.cases.map((c: { caseNumber: string }) => c.caseNumber)).toContain(caseNumber);
    expect(JSON.stringify(all)).not.toMatch(/originals\/|storageKey|storage_key|bucket/i);
    expect((await call(client, '/evidence?unknown=1')).statusCode).toBe(400);
  });

  it('returns metadata + hashes for visible items and 404 for others (custody audited)', async () => {
    const r = await call(client, `/evidence/${A.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: A.id, evidenceNumber: A.evidenceNumber, hashes: { sha256: A.sha256, sha512: A.sha512 } });
    expect((await call(client, `/evidence/${B.id}`)).statusCode).toBe(404);
    const v = await app.db.selectFrom('audit_events').select(['actor_type', 'actor_id', 'details']).where('evidence_id', '=', A.id).where('action', '=', 'EVIDENCE_VIEWED').where('actor_type', '=', 'API_CLIENT').execute();
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]!.actor_id).toBe(client.id);
  });

  it('is usable by signed-in users (their own visibility applies)', async () => {
    const r = await (await as('io.arjun')).get('/api/v1/integration/evidence?pageSize=100');
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(B.id);
    expect(ids).not.toContain(A.id);
  });
});

describe('integration downloads', () => {
  it('issues a short-lived tokenised URL that streams the original and records custody', async () => {
    expect((await call(readOnly, `/evidence/${A.id}/download`)).statusCode).toBe(403);
    expect((await call(client, `/evidence/${B.id}/download`)).statusCode).toBe(404);
    const r = await call(client, `/evidence/${A.id}/download`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.url).toMatch(new RegExp(`^/api/v1/media/download/${A.id}\\?t=`));
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(301_000);
    expect(body.sha256).toBe(A.sha256);
    const dl = await app.inject({ method: 'GET', url: body.url });
    expect(dl.statusCode).toBe(200);
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(A.sha256);
    const ev = await app.db.selectFrom('audit_events').select(['actor_type', 'actor_id', 'details']).where('evidence_id', '=', A.id).where('action', '=', 'EVIDENCE_DOWNLOADED').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ actor_type: 'API_CLIENT', actor_id: client.id });
    expect((ev.details as { via: string }).via).toBe('api_client');
    const issued = await app.db.selectFrom('audit_events').select('seq').where('evidence_id', '=', A.id).where('action', '=', 'EVIDENCE_DOWNLOAD_LINK_ISSUED').execute();
    expect(issued.length).toBeGreaterThanOrEqual(1);
    // Token is bound to the evidence item.
    const other = await app.inject({ method: 'GET', url: body.url.replace(A.id, B.id) });
    expect(other.statusCode).toBe(403);
  });

  it('stops honouring download tokens once the client is revoked', async () => {
    const c = await mkClient(['evidence:read', 'evidence:download_original']);
    const url = (await call(c, `/evidence/${A.id}/download`)).json().url as string;
    await (await as('admin')).post(`/api/v1/api-clients/${c.id}/revoke`, { reason: 'Compromised credentials' });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
});

describe('integration cases', () => {
  it('returns case summary by number with FIR and visible linked evidence; jurisdiction and scope enforced', async () => {
    const r = await call(client, `/cases/${caseNumber}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ caseNumber, fir: { firNumber: '0321', firYear: FIR_YEAR }, hiddenEvidenceCount: 0 });
    expect(r.json().evidence.map((e: { id: string }) => e.id)).toEqual([A.id]);
    expect((await call(readOnly, `/cases/${caseNumber}`)).statusCode).toBe(403);
    const naz = await (await as('admin')).post('/api/v1/api-clients', { name: 'Mysuru client', scopes: ['cases:read'], orgUnitId: org.ps_nazarbad });
    expect((await call({ clientId: naz.body.clientId, secret: naz.body.clientSecret }, `/cases/${caseNumber}`)).statusCode).toBe(404);
  });
});

describe('integration API auditing and rate limiting', () => {
  it('audits every call with the API client as actor', async () => {
    const before = await app.db.selectFrom('audit_events').select(sql<number>`count(*)::int`.as('n')).where('action', '=', 'INTEGRATION_API_REQUEST').where('actor_id', '=', client.id).executeTakeFirstOrThrow();
    await call(client, '/evidence');
    await call(client, `/evidence/${B.id}`); // 404 still audited
    const after = await app.db.selectFrom('audit_events').select(sql<number>`count(*)::int`.as('n')).where('action', '=', 'INTEGRATION_API_REQUEST').where('actor_id', '=', client.id).executeTakeFirstOrThrow();
    expect(after.n - before.n).toBe(2);
  });

  it('rate limits per client', async () => {
    const c = await mkClient(['evidence:read'], { rateLimitPerMinute: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call(c, '/evidence')).statusCode);
    expect(codes).toContain(429);
    // Other clients are unaffected.
    expect((await call(client, '/evidence')).statusCode).toBe(200);
    const rl = await app.db.selectFrom('audit_events').select('seq').where('action', '=', 'RATE_LIMITED').where('resource_id', '=', c.id).execute();
    expect(rl.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the audit chain verifiable', async () => {
    const { rows } = await sql<{ first_bad_seq: number | null }>`SELECT * FROM audit_verify()`.execute(app.db);
    expect(rows[0]!.first_bad_seq).toBeNull();
  });
});
