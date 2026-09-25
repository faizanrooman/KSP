import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';

let app: FastifyInstance;
const U: Record<string, string> = {};
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
let A: CreatedEvidence; // Cubbon Park
let B: CreatedEvidence; // Indiranagar
let D: CreatedEvidence; // High Grounds
let caseId: string;
let caseNumber: string;
let cubbonId: string;

beforeAll(async () => {
  app = await evidenceTestSetup();
  for (const u of ['fo.ravi', 'io.meera', 'io.arjun', 'sup.kavya', 'io.mysuru', 'fa.naveen', 'admin']) U[u] = await userId(u);
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['fo.ravi']!, officerId: U['fo.ravi']!, title: 'Case test clip A' });
  B = await createRegisteredEvidence({ orgCode: 'ps_indiranagar', uploadedBy: U['io.arjun']!, title: 'Case test clip B' });
  D = await createRegisteredEvidence({ orgCode: 'ps_highgrounds', uploadedBy: U['sup.kavya']!, title: 'Case test clip D' });
  cubbonId = (await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow()).id;
}, 180_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('case creation and authorization', () => {
  it('rejects unauthenticated (401) and callers without case permissions (403)', async () => {
    const anon = new Agent(app);
    expect((await anon.get('/api/v1/cases')).status).toBe(401);
    expect((await anon.post('/api/v1/cases', { title: 'x' })).status).toBe(401);
    expect((await (await as('fo.ravi')).get('/api/v1/cases')).status).toBe(403);
    expect((await (await as('admin')).post('/api/v1/cases', { title: 'Admin case' })).status).toBe(403);
    expect((await (await as('fa.naveen')).post('/api/v1/cases', { title: 'Analyst case' })).status).toBe(403);
  });

  it('creates a case with an auto number, default IO = creator, and validates IO/supervisor', async () => {
    const meera = await as('io.meera');
    const r = await meera.post('/api/v1/cases', { title: 'Chain snatching near Cubbon Park', priority: 'HIGH', supervisorId: U['sup.kavya'] });
    expect(r.status, r.raw).toBe(201);
    caseId = r.body.id;
    caseNumber = r.body.caseNumber;
    expect(caseNumber).toMatch(new RegExp(`^CASE-CUBBONPARK-${new Date().getUTCFullYear()}-\\d{4}$`));
    expect(r.body.investigatingOfficer.id).toBe(U['io.meera']);
    expect(r.body.supervisor.id).toBe(U['sup.kavya']);
    expect(r.body.status).toBe('OPEN');
    const r2 = await meera.post('/api/v1/cases', { title: 'Second case same station' });
    const n1 = Number(caseNumber.split('-').pop());
    expect(Number(r2.body.caseNumber.split('-').pop())).toBe(n1 + 1);

    // IO from another district is rejected; field officer lacks case access.
    const bad = await meera.post('/api/v1/cases', { title: 'Bad IO case', investigatingOfficerId: U['io.mysuru'] });
    expect(bad.status).toBe(422);
    const fo = await meera.post('/api/v1/cases', { title: 'Bad IO case 2', investigatingOfficerId: U['fo.ravi'] });
    expect(fo.status).toBe(422);
    // Station outside jurisdiction -> 404.
    const naz = (await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_nazarbad').executeTakeFirstOrThrow()).id;
    expect((await meera.post('/api/v1/cases', { title: 'Mysuru case', orgUnitId: naz })).status).toBe(404);
  });

  it('applies jurisdiction to list/detail (other jurisdiction -> 404)', async () => {
    expect((await (await as('io.meera')).get(`/api/v1/cases/${caseId}`)).status).toBe(200);
    expect((await (await as('sup.kavya')).get(`/api/v1/cases/${caseId}`)).status).toBe(200);
    expect((await (await as('io.arjun')).get(`/api/v1/cases/${caseId}`)).status).toBe(404);
    expect((await (await as('io.mysuru')).get(`/api/v1/cases/${caseId}`)).status).toBe(404);
    expect((await (await as('io.mysuru')).patch(`/api/v1/cases/${caseId}`, { title: 'hijack' })).status).toBe(404);
    const list = await (await as('io.arjun')).get('/api/v1/cases?pageSize=200');
    expect(list.status).toBe(200);
    expect(list.body.items.some((c: { id: string }) => c.id === caseId)).toBe(false);
    const mine = await (await as('io.meera')).get(`/api/v1/cases?q=${encodeURIComponent('chain snatching')}&status=OPEN&priority=HIGH&sort=-priority`);
    expect(mine.body.items.map((c: { id: string }) => c.id)).toContain(caseId);
    expect((await (await as('io.meera')).get('/api/v1/cases?sort=password_hash')).status).toBe(400);
  });

  it('edits case details with audit', async () => {
    const r = await (await as('io.meera')).patch(`/api/v1/cases/${caseId}`, { courtName: 'ACMM Court Bengaluru', courtCaseNumber: 'CC 123/2026' });
    expect(r.status).toBe(200);
    expect(r.body.court).toEqual({ name: 'ACMM Court Bengaluru', caseNumber: 'CC 123/2026' });
  });
});

describe('case status workflow', () => {
  it('validates transitions and requires reasons for close/reopen', async () => {
    const meera = await as('io.meera');
    const c = (await meera.post('/api/v1/cases', { title: 'Workflow case' })).body.id as string;
    const st = (status: string, reason?: string) => meera.post(`/api/v1/cases/${c}/status`, reason ? { status, reason } : { status });
    expect((await st('IN_TRIAL')).status).toBe(409);
    expect((await st('UNDER_INVESTIGATION')).status).toBe(200);
    expect((await st('PENDING_TRIAL')).status).toBe(200);
    expect((await st('OPEN')).status).toBe(409);
    expect((await st('IN_TRIAL')).status).toBe(200);
    expect((await st('CLOSED')).status).toBe(400);
    const closed = await st('CLOSED', 'Judgment delivered, accused convicted');
    expect(closed.status).toBe(200);
    expect(closed.body.closedAt).toBeTruthy();
    expect((await st('ARCHIVED', 'Archive after appeal window')).status).toBe(200);
    expect((await meera.patch(`/api/v1/cases/${c}`, { title: 'edit archived' })).status).toBe(409);
    expect((await st('UNDER_INVESTIGATION')).status).toBe(400);
    const re = await st('UNDER_INVESTIGATION', 'Reopened on court direction');
    expect(re.status).toBe(200);
    expect(re.body.closedAt).toBeNull();
    const ev = await app.db.selectFrom('audit_events').select(['details']).where('case_id', '=', c).where('action', '=', 'CASE_STATUS_CHANGED').orderBy('seq').execute();
    expect(ev.map((e) => (e.details as { to: string }).to)).toEqual(['UNDER_INVESTIGATION', 'PENDING_TRIAL', 'IN_TRIAL', 'CLOSED', 'ARCHIVED', 'UNDER_INVESTIGATION']);
    expect((ev.at(-1)!.details as { reopen: boolean }).reopen).toBe(true);
  });
});

describe('evidence linking and case-based visibility', () => {
  it('links visible evidence, reports out-of-scope items as NOT_FOUND without leaking, and writes custody events', async () => {
    const meera = await as('io.meera');
    const r = await meera.post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [A.id, B.id, '00000000-0000-4000-8000-000000000000'], note: 'Patrol BWC footage' });
    expect(r.status, r.raw).toBe(200);
    const by = Object.fromEntries(r.body.results.map((x: { evidenceId: string; status: string }) => [x.evidenceId, x]));
    expect(by[A.id].status).toBe('LINKED');
    expect(by[B.id]).toEqual({ evidenceId: B.id, status: 'NOT_FOUND' });
    expect(by['00000000-0000-4000-8000-000000000000']).toEqual({ evidenceId: '00000000-0000-4000-8000-000000000000', status: 'NOT_FOUND' });
    const again = await meera.post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [A.id] });
    expect(again.body.results[0].status).toBe('ALREADY_LINKED');
    const custody = await app.db.selectFrom('audit_events').select(['case_id', 'evidence_id', 'category']).where('action', '=', 'EVIDENCE_LINKED_TO_CASE').where('evidence_id', '=', A.id).execute();
    expect(custody).toHaveLength(1);
    expect(custody[0]).toMatchObject({ case_id: caseId, evidence_id: A.id, category: 'CUSTODY' });
    // Supervisor (district scope) links High Grounds evidence to the same case.
    const k = await (await as('sup.kavya')).post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [D.id] });
    expect(k.body.results[0].status).toBe('LINKED');
  });

  it('requires cases:link_evidence and case access for linking', async () => {
    expect((await (await as('fa.naveen')).post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [A.id] })).status).toBe(403);
    expect((await (await as('io.arjun')).post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [B.id] })).status).toBe(404);
    expect((await new Agent(app).post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [A.id] })).status).toBe(401);
  });

  it('lists linked evidence with a hidden count for items the caller cannot see', async () => {
    // The IO sees every linked item (case-based visibility, rule 3), including High Grounds evidence D.
    const io = await (await as('io.meera')).get(`/api/v1/cases/${caseId}/evidence`);
    expect(io.body.items).toHaveLength(2);
    expect(io.body.hiddenCount).toBe(0);
    // A Cubbon Park analyst (jurisdiction access, not on the team) sees A only; D is counted as hidden.
    const analyst = await createUser({ role: 'FORENSIC_ANALYST', org: 'ps_cubbonpark' });
    const r = await (await login(analyst.username)).get(`/api/v1/cases/${caseId}/evidence`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { evidence: { id: string } }) => i.evidence.id)).toEqual([A.id]);
    expect(r.body.hiddenCount).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/originals\/|storageKey|storage_key/);
    const k = await (await as('sup.kavya')).get(`/api/v1/cases/${caseId}/evidence`);
    expect(k.body.items).toHaveLength(2);
    expect(k.body.hiddenCount).toBe(0);
  });

  it('member added -> sees linked evidence from another station; removed -> 404', async () => {
    const arjun = await as('io.arjun');
    expect((await arjun.get(`/api/v1/evidence/${A.id}`)).status).toBe(404);
    expect((await (await as('io.meera')).post(`/api/v1/cases/${caseId}/members`, { userId: U['fo.ravi'] })).status).toBe(422); // no cases:read
    const add = await (await as('io.meera')).post(`/api/v1/cases/${caseId}/members`, { userId: U['io.arjun'], role: 'ANALYST' });
    expect(add.status, add.raw).toBe(201);
    expect((await (await as('io.meera')).post(`/api/v1/cases/${caseId}/members`, { userId: U['io.arjun'] })).status).toBe(409);
    expect((await arjun.get(`/api/v1/cases/${caseId}`)).status).toBe(200);
    expect((await arjun.get(`/api/v1/evidence/${A.id}`)).status).toBe(200);
    expect((await arjun.get(`/api/v1/evidence/${B.id}`)).status).toBe(200); // own jurisdiction
    const detail = await arjun.get(`/api/v1/cases/${caseId}`);
    expect(detail.body.permissions.onTeam).toBe(true);
    expect(detail.body.permissions.canManage).toBe(false);
    // Member can link evidence they can see (their own station's clip B).
    const lb = await arjun.post(`/api/v1/cases/${caseId}/evidence`, { evidenceIds: [B.id] });
    expect(lb.body.results[0].status).toBe('LINKED');
    // Meera now sees B through the case too.
    expect((await (await as('io.meera')).get(`/api/v1/evidence/${B.id}`)).status).toBe(200);
    // Members cannot manage the team.
    const selfRm = await arjun.delete(`/api/v1/cases/${caseId}/members/${U['io.arjun']}`);
    expect(selfRm.status, selfRm.raw).toBe(404);
    const rm = await (await as('io.meera')).delete(`/api/v1/cases/${caseId}/members/${U['io.arjun']}`, { reason: 'Assistance complete' });
    expect(rm.status).toBe(200);
    expect((await arjun.get(`/api/v1/evidence/${A.id}`)).status).toBe(404);
    expect((await arjun.get(`/api/v1/cases/${caseId}`)).status).toBe(404);
  });

  it('unlinks with a reason (soft) and records custody; unlinked evidence no longer grants visibility', async () => {
    const meera = await as('io.meera');
    expect((await meera.delete(`/api/v1/cases/${caseId}/evidence/${B.id}`, {})).status).toBe(400);
    const r = await meera.delete(`/api/v1/cases/${caseId}/evidence/${B.id}`, { reason: 'Unrelated incident' });
    expect(r.status, r.raw).toBe(200);
    expect((await meera.delete(`/api/v1/cases/${caseId}/evidence/${B.id}`, { reason: 'Unrelated incident' })).status).toBe(404);
    const row = await app.db.selectFrom('case_evidence').select(['unlinked_at', 'unlinked_by', 'unlink_reason']).where('case_id', '=', caseId).where('evidence_id', '=', B.id).executeTakeFirstOrThrow();
    expect(row.unlinked_by).toBe(U['io.meera']);
    expect(row.unlink_reason).toBe('Unrelated incident');
    const ev = await app.db.selectFrom('audit_events').select(['case_id', 'evidence_id']).where('action', '=', 'EVIDENCE_UNLINKED_FROM_CASE').where('evidence_id', '=', B.id).executeTakeFirstOrThrow();
    expect(ev.case_id).toBe(caseId);
    expect((await meera.get(`/api/v1/evidence/${B.id}`)).status).toBe(404);
    const hist = await meera.get(`/api/v1/cases/${caseId}/evidence?includeUnlinked=true`);
    expect(hist.body.items.some((i: { unlinkedAt: string | null }) => i.unlinkedAt)).toBe(false); // B no longer visible to Meera at all
    // Link rows cannot be deleted at the DB level.
    await expect(app.db.deleteFrom('case_evidence').where('case_id', '=', caseId).execute()).rejects.toThrow(/permission denied/);
  });

  it('shows linked cases on the evidence detail', async () => {
    const r = await (await as('io.meera')).get(`/api/v1/evidence/${A.id}`);
    expect(r.body.cases.map((c: { id: string }) => c.id)).toContain(caseId);
  });
});

describe('case diary and timeline', () => {
  it('appends notes (team or manager only); DB rejects UPDATE/DELETE', async () => {
    const meera = await as('io.meera');
    const n = await meera.post(`/api/v1/cases/${caseId}/notes`, { body: 'Visited scene; collected CCTV from shop 12.' });
    expect(n.status).toBe(201);
    expect((await (await as('fa.naveen')).post(`/api/v1/cases/${caseId}/notes`, { body: 'Analyst not on team' })).status).toBe(404);
    expect((await (await as('io.mysuru')).get(`/api/v1/cases/${caseId}/notes`)).status).toBe(404);
    const list = await meera.get(`/api/v1/cases/${caseId}/notes`);
    expect(list.body.items[0].body).toContain('collected CCTV');
    expect((await meera.patch(`/api/v1/cases/${caseId}/notes/${n.body.id}`, { body: 'edited' })).status).toBe(405);
    await expect(app.db.updateTable('case_notes').set({ body: 'tampered' }).where('id', '=', n.body.id).execute()).rejects.toThrow(/permission denied/);
    await expect(app.db.deleteFrom('case_notes').where('id', '=', n.body.id).execute()).rejects.toThrow(/permission denied/);
  });

  it('merges case events, notes, status changes and linked-evidence custody into one timeline', async () => {
    // Custody event on linked evidence A while linked (a view by the supervisor).
    await (await as('sup.kavya')).get(`/api/v1/evidence/${A.id}`);
    const t = await (await as('sup.kavya')).get(`/api/v1/cases/${caseId}/timeline?includeViews=true`);
    expect(t.status).toBe(200);
    const types = t.body.items.map((i: { type: string }) => i.type);
    for (const x of ['CASE_CREATED', 'CASE_UPDATED', 'EVIDENCE_LINKED_TO_CASE', 'EVIDENCE_UNLINKED_FROM_CASE', 'CASE_MEMBER_CHANGED', 'CASE_NOTE', 'EVIDENCE_VIEWED']) expect(types).toContain(x);
    const times = t.body.items.map((i: { at: string }) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(t.body.includesEvidenceCustody).toBe(true);
    // IO without custody:read? (IO has custody:read) — Meera must not see B's number (not visible to her).
    const m = await (await as('io.meera')).get(`/api/v1/cases/${caseId}/timeline`);
    const unlink = m.body.items.find((i: { type: string }) => i.type === 'EVIDENCE_UNLINKED_FROM_CASE');
    expect(unlink.evidenceId).toBeNull();
    expect(JSON.stringify(m.body)).not.toContain(B.evidenceNumber);
    expect((await (await as('io.mysuru')).get(`/api/v1/cases/${caseId}/timeline`)).status).toBe(404);
  });
});

describe('case access for ad-hoc users', () => {
  it('lets a supervisor from an ancestor unit be assigned; station user without manage cannot edit', async () => {
    const analyst = await createUser({ role: 'FORENSIC_ANALYST', org: 'ps_cubbonpark' });
    const a = await login(analyst.username);
    expect((await a.get(`/api/v1/cases/${caseId}`)).status).toBe(200);
    expect((await a.patch(`/api/v1/cases/${caseId}`, { title: 'Analyst edit attempt' })).status).toBe(403);
    const r = await (await as('io.meera')).post('/api/v1/cases', { title: 'Ancestor supervisor', orgUnitId: cubbonId, supervisorId: U['sup.kavya'] });
    expect(r.status).toBe(201);
  });

  it('keeps the audit chain verifiable', async () => {
    const { rows } = await sql<{ checked: number; first_bad_seq: number | null }>`SELECT * FROM audit_verify()`.execute(app.db);
    expect(rows[0]!.first_bad_seq).toBeNull();
  });
});
