import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { runReportBuild } from '../../worker/src/jobs/reports/build.js';

let app: FastifyInstance;
let kavya: Agent, auditor: Agent, admin: Agent, ravi: Agent, meera: Agent;
let cubbonNo: string, nazarbadNo: string;

beforeAll(async () => {
  app = await evidenceTestSetup();
  [kavya, auditor, admin, ravi, meera] = await Promise.all(['sup.kavya', 'aud.suresh', 'admin', 'fo.ravi', 'io.meera'].map((u) => login(u)));
  const op = await userId('op.cubbon');
  cubbonNo = (await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: op })).evidenceNumber;
  nazarbadNo = (await createRegisteredEvidence({ orgCode: 'ps_nazarbad', uploadedBy: op })).evidenceNumber;
}, 120_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const orgId = async (code: string) => (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
const build = (id: string) => runReportBuild({ db: app.db, storage: app.storage }, id);
async function download(a: Agent, id: string) {
  const link = await a.post(`/api/v1/reports/runs/${id}/download-link`);
  expect(link.status).toBe(200);
  const res = await app.inject({ method: 'GET', url: link.body.url }); // no cookies: the token alone authorises
  return { link, res };
}

describe('reports API', () => {
  it('401 / 403 matrix and per-type permissions (audited denial)', async () => {
    const anon = new Agent(app);
    expect((await anon.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY' })).status).toBe(401);
    expect((await anon.get('/api/v1/reports/runs')).status).toBe(401);
    expect((await ravi.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY' })).status).toBe(403);
    expect((await meera.get('/api/v1/reports/types')).status).toBe(403);
    const denied = await kavya.post('/api/v1/reports/runs', { reportType: 'ACCESS_AUDIT', format: 'CSV' });
    expect(denied.status).toBe(403);
    const a = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'ACCESS_DENIED').where('resource_id', '=', 'ACCESS_AUDIT').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(a.details).toMatchObject({ missing: ['audit:read'] });
    expect((await admin.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY' })).status).toBe(403); // admin has no evidence:read
    expect((await admin.post('/api/v1/reports/runs', { reportType: 'USER_ACCESS_REVIEW', inactiveDays: 60 })).status).toBe(201);
    const types = await kavya.get('/api/v1/reports/types');
    const byCode = Object.fromEntries(types.body.items.map((t: { code: string }) => [t.code, t]));
    expect(byCode.ACCESS_AUDIT.available).toBe(false);
    expect(byCode.EVIDENCE_INVENTORY).toMatchObject({ available: true, jurisdiction: ['ksp.blr_city.blr_central'] });
  });

  it('validation: bad period, params not belonging to the type, org unit outside jurisdiction → 404', async () => {
    expect((await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', from: '2026-02-01', to: '2026-01-01' })).status).toBe(400);
    expect((await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', inactiveDays: 30 })).status).toBe(400);
    expect((await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', format: 'XLSX' })).status).toBe(400);
    expect((await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', orgUnitId: await orgId('ps_nazarbad') })).status).toBe(404);
    expect((await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', orgUnitId: await orgId('ps_cubbonpark') })).status).toBe(201);
  });

  it('CSV end-to-end: queued → built → tokenised download (sha256 matches, audited) → scoped content', async () => {
    const r = await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', format: 'CSV' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'QUEUED', reportType: 'EVIDENCE_INVENTORY', format: 'CSV', params: { jurisdiction: ['ksp.blr_city.blr_central'] } });
    const id = r.body.id as string;
    expect((await kavya.post(`/api/v1/reports/runs/${id}/download-link`)).status).toBe(409); // not ready
    const job = await app.db.selectFrom('pgboss.job' as never).select('data' as never).where('name' as never, '=', 'report.build' as never).execute() as unknown as Array<{ data: { reportRunId: string } }>;
    expect(job.some((j) => j.data.reportRunId === id)).toBe(true);
    expect((await build(id)).status).toBe('COMPLETED');
    const run = await kavya.get(`/api/v1/reports/runs/${id}`);
    expect(run.body).toMatchObject({ status: 'COMPLETED', rowCount: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const { res } = await download(kavya, id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="evidence_inventory-/);
    const body = res.rawPayload;
    expect(createHash('sha256').update(body).digest('hex')).toBe(run.body.sha256);
    expect(res.headers['x-content-sha256']).toBe(run.body.sha256);
    const text = body.toString('utf8');
    expect(text).toContain('ps_cubbonpark');
    expect(text).not.toContain('ps_nazarbad');
    expect(text).not.toContain('ps_indiranagar');
    const audit = await app.db.selectFrom('audit_events').select(['actor_id', 'details']).where('action', '=', 'REPORT_DOWNLOADED').where('resource_id', '=', id).executeTakeFirstOrThrow();
    expect(audit.actor_id).toBe(await userId('sup.kavya'));
    expect((await app.db.selectFrom('audit_events').select('seq').where('action', '=', 'REPORT_REQUESTED').where('resource_id', '=', id).executeTakeFirst())).toBeTruthy();
    expect((await kavya.get(`/api/v1/reports/runs/${id}`)).body.downloadCount).toBe(1);
    // listing: mine only
    expect((await kavya.get('/api/v1/reports/runs')).body.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await auditor.get('/api/v1/reports/runs')).body.items.map((x: { id: string }) => x.id)).not.toContain(id);
    expect((await auditor.get(`/api/v1/reports/runs/${id}`)).status).toBe(404);
    expect((await auditor.post(`/api/v1/reports/runs/${id}/download-link`)).status).toBe(404);
  });

  it('download tokens: tampered, wrong run, revoked session → 401', async () => {
    const r = await kavya.post('/api/v1/reports/runs', { reportType: 'INTEGRITY', format: 'JSON' });
    await build(r.body.id);
    const other = await kavya.post('/api/v1/reports/runs', { reportType: 'INTEGRITY', format: 'CSV' });
    await build(other.body.id);
    const link = (await kavya.post(`/api/v1/reports/runs/${r.body.id}/download-link`)).body.url as string;
    const t = new URL(link, 'http://x').searchParams.get('t')!;
    // Flip a full-entropy character in the middle of the token (the last base64url char carries only 4 significant bits).
    const tamper = (v: string) => { const i = Math.floor(v.length / 2); return v.slice(0, i) + (v[i] === 'A' ? 'B' : 'A') + v.slice(i + 1); };
    expect((await app.inject({ method: 'GET', url: `/api/v1/reports/runs/${r.body.id}/download?t=${tamper(t)}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/reports/runs/${other.body.id}/download?t=${encodeURIComponent(t)}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/reports/runs/${r.body.id}/download` })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'GET', url: link });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).report.type).toBe('INTEGRITY');
    const sid = (await kavya.get('/api/v1/auth/me')).body.sessionId as string;
    await app.db.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'test' }).where('id', '=', sid).execute();
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(401);
    kavya = await login('sup.kavya');
  });

  it('auditor (state-wide) runs ACCESS_AUDIT as PDF; contents cover all districts', async () => {
    const r = await auditor.post('/api/v1/reports/runs', { reportType: 'CHAIN_OF_CUSTODY_SUMMARY', format: 'CSV' });
    expect(r.status).toBe(201);
    expect(r.body.params.jurisdiction).toEqual(['ksp']);
    await build(r.body.id);
    const { res } = await download(auditor, r.body.id);
    expect(res.body).toContain(cubbonNo);
    expect(res.body).toContain(nazarbadNo);
    const pdf = await auditor.post('/api/v1/reports/runs', { reportType: 'ACCESS_AUDIT', format: 'PDF' });
    expect(pdf.status).toBe(201);
    await build(pdf.body.id);
    const d = await download(auditor, pdf.body.id);
    expect(d.res.headers['content-type']).toBe('application/pdf');
    expect(d.res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
