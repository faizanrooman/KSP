import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { GetObjectLegalHoldCommand, PutObjectLegalHoldCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { runDisposal } from '../../worker/src/jobs/lifecycle/disposal.js';
import { runFixityCheck } from '../../worker/src/jobs/lifecycle/fixity.js';
import { listVersions } from '../../worker/src/jobs/lifecycle/common.js';

let app: FastifyInstance;
const U: Record<string, string> = {};
let A: CreatedEvidence; // Cubbon Park, uploaded + recorded by fo.ravi
let B: CreatedEvidence; // Indiranagar, io.arjun
let C: CreatedEvidence; // Cubbon Park, op.cubbon
let D: CreatedEvidence; // High Grounds, sup.kavya
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const url = (e: { id: string }, rest = '') => `/api/v1/evidence/${e.id}${rest}`;

function assertNoStorageLeak(body: unknown, evs: CreatedEvidence[]) {
  const s = JSON.stringify(body);
  expect(s).not.toMatch(/storage_?key|storage_?bucket|storage_?version|storageKey|storageBucket|storageVersion|originals\//i);
  for (const e of evs) {
    expect(s).not.toContain(e.bucket);
    expect(s).not.toContain(e.key);
    if (e.versionId) expect(s).not.toContain(e.versionId);
  }
}

beforeAll(async () => {
  app = await evidenceTestSetup();
  for (const u of ['fo.ravi', 'op.cubbon', 'io.meera', 'io.arjun', 'sup.kavya', 'aud.suresh', 'ec.latha', 'admin', 'io.mysuru']) U[u] = await userId(u);
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['fo.ravi']!, officerId: U['fo.ravi']!, title: 'Traffic stop MG Road', category: 'TRAFFIC', gps: { lat: 12.9763, lon: 77.5929 } });
  B = await createRegisteredEvidence({ orgCode: 'ps_indiranagar', uploadedBy: U['io.arjun']!, title: 'Indiranagar market altercation' });
  C = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']!, title: 'Station bulk upload clip' });
  D = await createRegisteredEvidence({ orgCode: 'ps_highgrounds', uploadedBy: U['sup.kavya']!, title: 'High Grounds night patrol' });
}, 180_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('evidence access control', () => {
  it('requires authentication and an evidence permission', async () => {
    const anon = new Agent(app);
    expect((await anon.get('/api/v1/evidence')).status).toBe(401);
    expect((await anon.get(url(A))).status).toBe(401);
    const r = await (await as('admin')).get('/api/v1/evidence');
    expect(r.status).toBe(403);
    expect((await (await as('admin')).get(url(A))).status).toBe(404);
  });

  it('applies the jurisdiction visibility matrix to list and detail', async () => {
    const ids = async (u: string) => new Set(((await (await as(u)).get('/api/v1/evidence?pageSize=200')).body.items as Array<{ id: string }>).map((i) => i.id));
    const meera = await ids('io.meera');
    expect(meera.has(A.id) && meera.has(C.id)).toBe(true);
    expect(meera.has(B.id) || meera.has(D.id)).toBe(false);
    const ravi = await ids('fo.ravi');
    expect(ravi.has(A.id)).toBe(true);
    expect(ravi.has(B.id) || ravi.has(C.id) || ravi.has(D.id)).toBe(false);
    const kavya = await ids('sup.kavya');
    expect(kavya.has(A.id) && kavya.has(C.id) && kavya.has(D.id)).toBe(true);
    expect(kavya.has(B.id)).toBe(false);
    const suresh = await ids('aud.suresh');
    for (const e of [A, B, C, D]) expect(suresh.has(e.id)).toBe(true);

    expect((await (await as('io.meera')).get(url(B))).status).toBe(404);
    expect((await (await as('io.meera')).patch(url(B), { title: 'x' })).status).toBe(404);
    expect((await (await as('fo.ravi')).get(url(C))).status).toBe(404);
    expect((await (await as('fo.ravi')).get(url(A))).status).toBe(200);
    expect((await (await as('io.meera')).get('/api/v1/evidence/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('grants access to the recipient of an active internal share', async () => {
    expect((await (await as('io.meera')).get(url(B))).status).toBe(404);
    const indira = await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_indiranagar').executeTakeFirstOrThrow();
    const share = await app.db
      .insertInto('shares')
      .values({ created_by: U['io.arjun']!, org_unit_id: indira.id, recipient_type: 'INTERNAL_USER', recipient_user_id: U['io.meera']!, purpose: 'Joint investigation', expires_at: new Date(Date.now() + 86_400_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await app.db.insertInto('share_items').values({ share_id: share.id, evidence_id: B.id }).execute();
    const r = await (await as('io.meera')).get(url(B));
    expect(r.status).toBe(200);
    expect(r.body.permissions.canDownloadOriginal).toBe(false);
    await app.db.updateTable('shares').set({ status: 'REVOKED', revoked_at: new Date() }).where('id', '=', share.id).execute();
    expect((await (await as('io.meera')).get(url(B))).status).toBe(404);
  });
});

describe('evidence detail & list', () => {
  it('returns the documented detail shape without storage locations and records a custody view', async () => {
    const r = await (await as('io.meera')).get(url(A));
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b).toMatchObject({ id: A.id, evidenceNumber: A.evidenceNumber, status: 'REGISTERED', sha256: A.sha256, sha512: A.sha512, sizeBytes: A.sizeBytes, storageTier: 'ACTIVE', legalHold: false, orgUnitId: A.orgUnitId });
    expect(b.orgUnit.name).toBe('Cubbon Park Police Station');
    expect(b.officer.fullName).toBe('Ravi Kumar');
    expect(b.uploadedBy.id).toBe(U['fo.ravi']);
    expect(b.width).toBe(320);
    expect(b.frameRate).toBe(25);
    expect(b.durationMs).toBeGreaterThan(1500);
    expect(b.videoCodec).toBe('h264');
    expect(b.gpsLatitude).toBeCloseTo(12.9763);
    expect(b.retentionPolicy?.name).toMatch(/Default/);
    expect(Array.isArray(b.tags) && Array.isArray(b.cases)).toBe(true);
    expect(b.permissions).toMatchObject({ canPlay: true, canEdit: true, canVerify: true, canLegalHold: false, canRequestDisposal: false, canDownloadOriginal: false, canLinkCase: true });
    assertNoStorageLeak(b, [A]);
    const viewed = await app.db.selectFrom('audit_events').select('seq').where('action', '=', 'EVIDENCE_VIEWED').where('evidence_id', '=', A.id).where('actor_id', '=', U['io.meera']!).execute();
    expect(viewed.length).toBeGreaterThan(0);
    const kavya = (await (await as('sup.kavya')).get(url(A))).body.permissions;
    expect(kavya).toMatchObject({ canLegalHold: true, canDownloadOriginal: true, canRequestDisposal: false });
    const latha = (await (await as('ec.latha')).get(url(A))).body.permissions;
    expect(latha).toMatchObject({ canRequestDisposal: true, canManageRetention: true, canPlay: false, canEdit: false });
    const ravi = (await (await as('fo.ravi')).get(url(A))).body.permissions;
    expect(ravi).toMatchObject({ canPlay: true, canEdit: false, canVerify: false });
  });

  it('lists with filters, sorting, pagination and camelCase items', async () => {
    const kavya = await as('sup.kavya');
    const central = await app.db.selectFrom('org_units').select('id').where('code', '=', 'blr_central').executeTakeFirstOrThrow();
    const cubbon = await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const byOrg = await kavya.get(`/api/v1/evidence?orgUnitId=${cubbon.id}&pageSize=200`);
    const orgIds = byOrg.body.items.map((i: { id: string }) => i.id);
    expect(orgIds).toContain(A.id);
    expect(orgIds).not.toContain(D.id);
    const sub = await kavya.get(`/api/v1/evidence?orgUnitId=${central.id}&pageSize=200`);
    expect(sub.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([A.id, C.id, D.id]));
    const q = await kavya.get(`/api/v1/evidence?q=${encodeURIComponent('night patrol')}`);
    expect(q.body.items.map((i: { id: string }) => i.id)).toContain(D.id);
    const num = await kavya.get(`/api/v1/evidence?q=${A.evidenceNumber}`);
    expect(num.body.items[0].id).toBe(A.id);
    const item = num.body.items[0];
    expect(item).toMatchObject({ evidenceNumber: A.evidenceNumber, status: 'REGISTERED', mediaStatus: 'PENDING', storageTier: 'ACTIVE', legalHold: false, thumbnailUrl: null });
    expect(item.officer).toMatchObject({ fullName: 'Ravi Kumar', badgeNumber: 'KSP-FO-1001' });
    expect(item.uploadedBy.fullName).toBe('Ravi Kumar');
    assertNoStorageLeak(num.body, [A, C, D]);
    const gps = await kavya.get('/api/v1/evidence?hasGps=true&pageSize=200');
    expect(gps.body.items.every((i: { id: string }) => i.id !== C.id)).toBe(true);
    expect(gps.body.items.map((i: { id: string }) => i.id)).toContain(A.id);
    const officer = await kavya.get(`/api/v1/evidence?officerId=${U['fo.ravi']}`);
    // Other suites may also record evidence for this officer: assert the filter's guarantee, not a global count.
    expect(officer.body.items.map((i: { id: string }) => i.id)).toContain(A.id);
    expect(officer.body.items.every((i: { officer: { id: string } | null }) => i.officer?.id === U['fo.ravi'])).toBe(true);
    const page = await kavya.get('/api/v1/evidence?pageSize=1&page=2&sort=size_bytes');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBeGreaterThanOrEqual(3);
    expect(page.body.page).toBe(2);
    expect((await kavya.get('/api/v1/evidence?sort=storage_key')).status).toBe(400);
    expect((await kavya.get('/api/v1/evidence?status=BOGUS')).status).toBe(400);
    expect((await kavya.get('/api/v1/evidence?status=REGISTERED,DISPOSAL_PENDING&legalHold=false')).status).toBe(200);
  });

  it('exposes a signed thumbnail URL when a thumbnail derivative exists', async () => {
    const d = await app.db
      .insertInto('evidence_derivatives')
      .values({ evidence_id: C.id, kind: 'THUMBNAIL', bucket: app.storage.bucket('derived'), object_key: `evidence/${C.id}/thumbnail/thumb.jpg`, mime_type: 'image/jpeg' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const r = await (await as('io.meera')).get(`/api/v1/evidence?q=${C.evidenceNumber}`);
    expect(r.body.items[0].thumbnailUrl).toMatch(new RegExp(`^/api/v1/media/image/${d.id}\\?t=`));
    expect(r.body.items[0].thumbnailUrl).not.toContain('derived');
  });

  it('offers no thumbnail for DISPOSED evidence (its derived media was deleted; the row stays)', async () => {
    const D = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']!, title: 'Disposed thumbnail probe' });
    await app.db
      .insertInto('evidence_derivatives')
      .values({ evidence_id: D.id, kind: 'THUMBNAIL', bucket: app.storage.bucket('derived'), object_key: `evidence/${D.id}/thumbnail/thumb.jpg`, mime_type: 'image/jpeg' })
      .execute();
    const meera = await as('io.meera');
    expect((await meera.get(`/api/v1/evidence?q=${D.evidenceNumber}`)).body.items[0].thumbnailUrl).toMatch(/^\/api\/v1\/media\/image\//);
    await sql`UPDATE evidence SET status = 'DISPOSAL_PENDING' WHERE id = ${D.id}::uuid`.execute(app.db);
    await sql`UPDATE evidence SET status = 'DISPOSED', disposed_at = now() WHERE id = ${D.id}::uuid`.execute(app.db);
    const r = await meera.get(`/api/v1/evidence?q=${D.evidenceNumber}&status=DISPOSED`);
    expect(r.body.items[0].status).toBe('DISPOSED');
    expect(r.body.items[0].thumbnailUrl).toBeNull();
  });
});

describe('metadata & tags', () => {
  it('edits only descriptive fields and audits before/after', async () => {
    const meera = await as('io.meera');
    const r = await meera.patch(url(A), { title: 'Traffic stop — MG Road junction', description: 'Two-wheeler stopped for signal violation', locationText: 'MG Road / Brigade Rd' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Traffic stop — MG Road junction');
    const ev = await app.db.selectFrom('audit_events').select(['details']).where('action', '=', 'EVIDENCE_METADATA_UPDATED').where('evidence_id', '=', A.id).orderBy('seq', 'desc').executeTakeFirstOrThrow();
    const changes = (ev.details as { changes: Record<string, { before: unknown; after: unknown }> }).changes;
    expect(changes.title).toEqual({ before: 'Traffic stop MG Road', after: 'Traffic stop — MG Road junction' });
    for (const bad of [{ sha256: 'a'.repeat(64) }, { status: 'DISPOSED' }, { title: 'x', storageKey: 'y' }, { recordedAt: new Date().toISOString() }]) {
      expect((await meera.patch(url(A), bad)).status).toBe(400);
    }
    expect((await (await as('fo.ravi')).patch(url(A), { title: 'nope' })).status).toBe(403);
    expect((await (await as('aud.suresh')).patch(url(A), { title: 'nope' })).status).toBe(403);
    const denied = await app.db.selectFrom('audit_events').select('seq').where('action', '=', 'EVIDENCE_ACCESS_DENIED').where('evidence_id', '=', A.id).execute();
    expect(denied.length).toBeGreaterThanOrEqual(2);
    // DB guard: immutable columns cannot change even via direct SQL.
    await expect(sql`UPDATE evidence SET sha256 = ${'b'.repeat(64)} WHERE id = ${A.id}::uuid`.execute(app.db)).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM evidence WHERE id = ${A.id}::uuid`.execute(app.db)).rejects.toThrow();
  });

  it('adds, validates, filters and removes manual tags', async () => {
    const meera = await as('io.meera');
    const add = await meera.post(url(A, '/tags'), { tag: 'Night Patrol' });
    expect(add.status).toBe(201);
    expect(add.body.tags).toEqual([{ tag: 'night patrol', source: 'MANUAL' }]);
    expect((await meera.post(url(A, '/tags'), { tag: 'night patrol' })).status).toBe(200);
    expect((await meera.post(url(A, '/tags'), { tag: '!!bad' })).status).toBe(400);
    expect((await (await as('fo.ravi')).post(url(A, '/tags'), { tag: 'x' })).status).toBe(403);
    const f = await meera.get('/api/v1/evidence?tag=night%20patrol');
    expect(f.body.items.map((i: { id: string }) => i.id)).toEqual([A.id]);
    const tagged = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'EVIDENCE_TAGGED').where('evidence_id', '=', A.id).execute();
    expect(tagged).toHaveLength(1);
    const del = await meera.delete(url(A, '/tags/night%20patrol'));
    expect(del.status).toBe(200);
    expect(del.body.tags).toEqual([]);
    expect((await meera.delete(url(A, '/tags/night%20patrol'))).status).toBe(404);
  });

  it('lists processing jobs', async () => {
    const r = await (await as('io.meera')).get(url(A, '/jobs'));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect((await (await as('io.meera')).get(url(B, '/jobs'))).status).toBe(404);
  });
});

describe('legal hold', () => {
  it('places a DB + S3 Object Lock legal hold that blocks disposal, then releases it', async () => {
    const kavya = await as('sup.kavya');
    expect((await (await as('io.meera')).post(url(A, '/legal-hold'), { reason: 'Court order 12/2026' })).status).toBe(403);
    expect((await kavya.post(url(A, '/legal-hold'), { reason: 'x' })).status).toBe(400);
    const r = await kavya.post(url(A, '/legal-hold'), { reason: 'Court order CC 1234/2026' });
    expect(r.status).toBe(200);
    // versitygw implements PutObjectLegalHold; the storage hold is applied to the original's version.
    expect(r.body.storageHold).toBe('APPLIED');
    const lh = await app.storage.s3.send(new GetObjectLegalHoldCommand({ Bucket: A.bucket, Key: A.key, VersionId: A.versionId }));
    expect(lh.LegalHold?.Status).toBe('ON');
    expect((await kavya.post(url(A, '/legal-hold'), { reason: 'again please' })).status).toBe(409);
    const detail = (await kavya.get(url(A))).body;
    expect(detail).toMatchObject({ legalHold: true, legalHoldReason: 'Court order CC 1234/2026' });
    expect(detail.legalHoldBy.id).toBe(U['sup.kavya']);

    // API: disposal cannot even be requested.
    const req = await (await as('ec.latha')).post(url(A, '/disposal-requests'), { reason: 'Retention period expired per policy', authorityRef: 'GO-2026-11' });
    expect(req.status).toBe(409);
    // DB: the evidence_guard trigger refuses disposal under legal hold.
    await expect(sql`UPDATE evidence SET status = 'DISPOSED' WHERE id = ${A.id}::uuid`.execute(app.db)).rejects.toThrow(/legal hold/);

    const rel = await kavya.delete(url(A, '/legal-hold'), { reason: 'Court released the hold' });
    expect(rel.status).toBe(200);
    const lh2 = await app.storage.s3.send(new GetObjectLegalHoldCommand({ Bucket: A.bucket, Key: A.key, VersionId: A.versionId }));
    expect(lh2.LegalHold?.Status).toBe('OFF');
    const life = (await kavya.get(url(A, '/lifecycle'))).body;
    expect(life.legalHoldHistory.map((h: { action: string }) => h.action)).toEqual(['RELEASED', 'SET']);
    assertNoStorageLeak(life, [A]);
    const actions = (await app.db.selectFrom('audit_events').select('action').where('evidence_id', '=', A.id).where('action', 'like', 'EVIDENCE_LEGAL_HOLD%').execute()).map((x) => x.action);
    expect(actions).toEqual(['EVIDENCE_LEGAL_HOLD_SET', 'EVIDENCE_LEGAL_HOLD_RELEASED']);
  });
});

describe('integrity', () => {
  it('queues on-demand verification and records a passing fixity check', async () => {
    const meera = await as('io.meera');
    expect((await (await as('fo.ravi')).post(url(A, '/verify'))).status).toBe(403);
    expect((await meera.post(url(B, '/verify'))).status).toBe(404);
    const q = await meera.post(url(A, '/verify'));
    expect(q.status).toBe(202);
    expect(q.body.queued).toBe(true);
    const job = await app.db.selectFrom('processing_jobs').select(['queue_job_id', 'status']).where('id', '=', q.body.jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('QUEUED');
    const res = await runFixityCheck({ db: app.db, storage: app.storage }, { evidenceId: A.id, trigger: 'ON_DEMAND', requestedBy: U['io.meera'] }, job.queue_job_id!);
    expect(res.status).toBe('OK');
    const done = await app.db.selectFrom('processing_jobs').select('status').where('id', '=', q.body.jobId).executeTakeFirstOrThrow();
    expect(done.status).toBe('COMPLETED');
    const integ = (await meera.get(url(A, '/integrity'))).body;
    expect(integ.lastResult).toBe('OK');
    expect(integ.lastVerifiedAt).toBeTruthy();
    expect(integ.items[0]).toMatchObject({ trigger: 'ON_DEMAND', ok: true, expectedSha256: A.sha256, actualSha256: A.sha256 });
    expect(integ.items[0].requestedBy.id).toBe(U['io.meera']);
    const audit = await app.db.selectFrom('audit_events').select('action').where('evidence_id', '=', A.id).where('action', 'in', ['EVIDENCE_INTEGRITY_CHECK_REQUESTED', 'EVIDENCE_INTEGRITY_VERIFIED']).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(['EVIDENCE_INTEGRITY_CHECK_REQUESTED', 'EVIDENCE_INTEGRITY_VERIFIED']);
  });

  it('detects a hash mismatch, records INTEGRITY_FAILED and raises a deduplicated CRITICAL alert', async () => {
    const bad = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['io.meera']!, corruptRecordedHash: true });
    const deps = { db: app.db, storage: app.storage };
    const r1 = await runFixityCheck(deps, { evidenceId: bad.id, trigger: 'SCHEDULED' });
    expect(r1.status).toBe('FAILED');
    expect(r1.reason).toMatch(/sha256/);
    expect(r1.actualSha256).toBe(bad.sha256);
    await runFixityCheck(deps, { evidenceId: bad.id, trigger: 'SCHEDULED' });
    const alert = await app.db.selectFrom('alerts').selectAll().where('dedupe_key', '=', `INTEGRITY_FAILURE:${bad.id}`).executeTakeFirstOrThrow();
    expect(alert).toMatchObject({ rule_code: 'INTEGRITY_FAILURE', severity: 'CRITICAL', status: 'OPEN', occurrences: 2, resource_id: bad.id });
    const checks = await app.db.selectFrom('integrity_checks').select(['ok', 'error']).where('evidence_id', '=', bad.id).execute();
    expect(checks.every((c) => !c.ok)).toBe(true);
    const failed = await app.db.selectFrom('audit_events').select(['outcome']).where('evidence_id', '=', bad.id).where('action', '=', 'EVIDENCE_INTEGRITY_FAILED').execute();
    expect(failed).toHaveLength(2);
    const ev = await app.db.selectFrom('evidence').select('last_verified_at').where('id', '=', bad.id).executeTakeFirstOrThrow();
    expect(ev.last_verified_at).toBeNull();
    const integ = (await (await as('io.meera')).get(url(bad, '/integrity'))).body;
    expect(integ.lastResult).toBe('FAILED');
  });
});

describe('disposal (separation of duties)', () => {
  const reason = 'Retention period elapsed; no case linkage';
  /** Routine disposal happens after the retention period: move retain_until into the past for the test item. */
  const retentionEnded = async (E: { id: string }) => { await app.db.updateTable('evidence').set({ retain_until: new Date(Date.now() - 86_400_000) }).where('id', '=', E.id).execute(); };

  it('before the end of retention only a court / government order authorises disposal; the approver must confirm it', async () => {
    const E = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']! });
    const latha = await as('ec.latha');
    const plain = await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-EARLY-1' });
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe('RETENTION_NOT_ENDED');
    const today = new Date().toISOString().slice(0, 10);
    const r = await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'CC 812/2026, ACMM Bengaluru', authorityType: 'COURT_ORDER', authorityDate: today });
    expect(r.status, r.raw).toBe(201);
    expect(r.body).toMatchObject({ early: true, authorityType: 'COURT_ORDER' });
    expect(new Date(r.body.retainUntilAtRequest).getTime()).toBeGreaterThan(Date.now()); // default policy: 7 years
    const kavya = await as('sup.kavya');
    const unconfirmed = await kavya.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'Order seen' });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe('EARLY_DISPOSAL_CONFIRMATION_REQUIRED');
    const ok = await kavya.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'Order CC 812/2026 verified', confirmEarly: true });
    expect(ok.status).toBe(200);
    const audit = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'EVIDENCE_DISPOSAL_APPROVED').where('resource_id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ early: true, confirmedEarly: true, authorityType: 'COURT_ORDER' });
  });

  it('enforces permissions, legal hold and single open request', async () => {
    const E = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']! });
    await retentionEnded(E);
    expect((await (await as('io.meera')).post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-1' })).status).toBe(403);
    expect((await (await as('io.arjun')).post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-1' })).status).toBe(404);
    const latha = await as('ec.latha');
    expect((await latha.post(url(E, '/disposal-requests'), { reason: 'too short', authorityRef: 'GO-1' })).status).toBe(400);
    const r = await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-2026-77' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PENDING', canCancel: true, canDecide: false });
    expect((await app.db.selectFrom('evidence').select('status').where('id', '=', E.id).executeTakeFirstOrThrow()).status).toBe('DISPOSAL_PENDING');
    expect((await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-2026-77' })).status).toBe(409);
    // Requester cannot approve (no permission) and ordinary IOs cannot see the queue.
    expect((await latha.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'ok by me' })).status).toBe(403);
    expect((await (await as('io.meera')).get('/api/v1/evidence/disposal-requests')).status).toBe(403);
    // Approver outside jurisdiction -> 404.
    const east = await createUser({ role: 'SUPERVISOR', org: 'blr_east' });
    expect((await (await login(east.username)).post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'looks fine' })).status).toBe(404);
    // Reject returns the evidence to REGISTERED.
    const kavya = await as('sup.kavya');
    const list = await kavya.get('/api/v1/evidence/disposal-requests?status=PENDING&pageSize=200');
    const mine = list.body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(mine).toMatchObject({ canDecide: true, status: 'PENDING' });
    assertNoStorageLeak(list.body, [E]);
    const rej = await kavya.post(`/api/v1/evidence/disposal-requests/${r.body.id}/reject`, { note: 'Case may be reopened' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('REJECTED');
    expect((await app.db.selectFrom('evidence').select('status').where('id', '=', E.id).executeTakeFirstOrThrow()).status).toBe('REGISTERED');
    // Cancel by requester.
    const r2 = await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-2026-78' });
    expect((await kavya.post(`/api/v1/evidence/disposal-requests/${r2.body.id}/cancel`, {})).status).toBe(403);
    const c = await latha.post(`/api/v1/evidence/disposal-requests/${r2.body.id}/cancel`, { note: 'raised in error' });
    expect(c.body.status).toBe('CANCELLED');
    expect((await app.db.selectFrom('evidence').select('status').where('id', '=', E.id).executeTakeFirstOrThrow()).status).toBe('REGISTERED');
  });

  it('refuses self-approval even for a user holding both roles', async () => {
    const dual = await createUser({ role: 'EVIDENCE_CUSTODIAN', org: 'blr_city' });
    const sup = await app.db.selectFrom('roles').select('id').where('code', '=', 'SUPERVISOR').executeTakeFirstOrThrow();
    const city = await app.db.selectFrom('org_units').select('id').where('code', '=', 'blr_city').executeTakeFirstOrThrow();
    await app.db.insertInto('user_roles').values({ user_id: dual.id, role_id: sup.id, org_unit_id: city.id }).execute();
    const E = await createRegisteredEvidence({ orgCode: 'ps_highgrounds', uploadedBy: U['op.cubbon']! });
    await retentionEnded(E);
    const ag = await login(dual.username);
    const r = await ag.post(url(E, '/disposal-requests'), { reason, authorityRef: 'GO-9' });
    expect(r.status).toBe(201);
    expect(r.body.canDecide).toBe(false);
    const a = await ag.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'self approval' });
    expect(a.status).toBe(403);
    expect(a.body.error.message).toMatch(/Separation of duties/);
    // DB CHECK constraint backs this up.
    await expect(app.db.updateTable('disposal_requests').set({ decided_by: dual.id }).where('id', '=', r.body.id).execute()).rejects.toThrow();
    // This SoD-violating combination was inserted behind the API's back: remove it so later files that edit the
    // custodian role (exports.test.ts EXT-10) do not trip over a user the API would never have allowed.
    await app.db.deleteFrom('user_roles').where('user_id', '=', dual.id).where('role_id', '=', sup.id).execute();
  });

  it('approves, executes (governance-bypass delete of all versions + derived) and keeps the record', async () => {
    const E = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']! });
    await retentionEnded(E);
    await app.storage.put(app.storage.bucket('derived'), `evidence/${E.id}/thumbnail/t.jpg`, Buffer.from('jpg'));
    // A READY court export package and an active internal share of the item exist before the disposal request.
    const exportsBucket = app.storage.bucket('exports');
    const pkgKey = `exports/test/${E.id}.zip`;
    await app.storage.put(exportsBucket, pkgKey, Buffer.from('zip'));
    const xp = await app.db.insertInto('exports').values({ export_number: `EXP-T-${E.id.slice(0, 8)}`, created_by: U['io.meera']!, org_unit_id: E.orgUnitId, purpose: 'Court production', status: 'READY', bucket: exportsBucket, object_key: pkgKey }).returning('id').executeTakeFirstOrThrow();
    await app.db.insertInto('export_items').values({ export_id: xp.id, evidence_id: E.id, expected_sha256: E.sha256 }).execute();
    const sh = await app.db.insertInto('shares').values({ created_by: U['io.meera']!, org_unit_id: E.orgUnitId, recipient_type: 'INTERNAL_USER', recipient_user_id: U['io.mysuru']!, purpose: 'Assist', expires_at: new Date(Date.now() + 86_400_000) }).returning('id').executeTakeFirstOrThrow();
    await app.db.insertInto('share_items').values({ share_id: sh.id, evidence_id: E.id }).execute();
    const latha = await as('ec.latha');
    const kavya = await as('sup.kavya');
    const r = await latha.post(url(E, '/disposal-requests'), { reason, authorityRef: 'Court order 55/2026' });
    const ap = await kavya.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'Verified authority reference' });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('APPROVED');
    expect(ap.body.jobId).toBeTruthy();
    expect((await kavya.post(`/api/v1/evidence/disposal-requests/${r.body.id}/approve`, { note: 'twice' })).status).toBe(409);
    const job = await app.db.selectFrom('processing_jobs').select('queue_job_id').where('id', '=', ap.body.jobId).executeTakeFirstOrThrow();

    expect((await listVersions(app.storage, E.bucket, E.key)).length).toBe(1);
    const res = await runDisposal({ db: app.db, storage: app.storage }, { disposalRequestId: r.body.id }, job.queue_job_id!);
    // versitygw honours x-amz-bypass-governance-retention for this principal: every version is really deleted.
    expect(res.status).toBe('EXECUTED');
    expect(res.versionsDeleted).toBe(1);
    expect(res.derivedDeleted).toBe(1);
    expect(await listVersions(app.storage, E.bucket, `originals/`).then((v) => v.filter((x) => x.key.includes(E.id)))).toEqual([]);
    expect(await app.storage.list(app.storage.bucket('derived'), `evidence/${E.id}/`)).toEqual([]);
    // Nothing outside the evidence prefixes keeps a copy: the export is revoked with its package deleted, the share revoked.
    expect(res).toMatchObject({ status: 'EXECUTED' });
    expect((await app.db.selectFrom('exports').select(['status', 'revoke_reason']).where('id', '=', xp.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'REVOKED' });
    expect(await app.storage.head(exportsBucket, pkgKey)).toBeNull();
    expect((await app.db.selectFrom('shares').select('status').where('id', '=', sh.id).executeTakeFirstOrThrow()).status).toBe('REVOKED');
    const exec = (await app.db.selectFrom('disposal_requests').select('execution_result').where('id', '=', r.body.id).executeTakeFirstOrThrow()).execution_result as Record<string, number>;
    expect(exec).toMatchObject({ exportsRevoked: 1, sharesRevoked: 1 });

    const row = await app.db.selectFrom('evidence').select(['status', 'disposed_at', 'sha256']).where('id', '=', E.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('DISPOSED');
    expect(row.disposed_at).toBeTruthy();
    expect(row.sha256).toBe(E.sha256);
    const d = await kavya.get(url(E));
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('DISPOSED');
    expect(d.body.permissions).toMatchObject({ canPlay: false, canEdit: false, canVerify: false, canRequestDisposal: false });
    expect((await kavya.patch(url(E), { title: 'after disposal' })).status).toBe(409);
    await expect(sql`UPDATE evidence SET title = 'x' WHERE id = ${E.id}::uuid`.execute(app.db)).rejects.toThrow(/final/);
    const dr = await app.db.selectFrom('disposal_requests').select(['status', 'executed_at', 'execution_error']).where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(dr).toMatchObject({ status: 'EXECUTED', execution_error: null });
    const actions = (await app.db.selectFrom('audit_events').select('action').where('evidence_id', '=', E.id).orderBy('seq').execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['EVIDENCE_REGISTERED', 'EVIDENCE_DISPOSAL_REQUESTED', 'EVIDENCE_DISPOSAL_APPROVED', 'EVIDENCE_DISPOSED']));
    // Idempotent re-run.
    expect((await runDisposal({ db: app.db, storage: app.storage }, { disposalRequestId: r.body.id })).status).toBe('SKIPPED');
  });

  it('never fakes success: a legal hold or a storage refusal leaves the request APPROVED with the error', async () => {
    const latha = await as('ec.latha');
    const kavya = await as('sup.kavya');
    const deps = { db: app.db, storage: app.storage };

    // (a) DB legal hold placed after approval.
    const E1 = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']! });
    await retentionEnded(E1);
    const r1 = await latha.post(url(E1, '/disposal-requests'), { reason, authorityRef: 'GO-A' });
    await kavya.post(`/api/v1/evidence/disposal-requests/${r1.body.id}/approve`, { note: 'approved first' });
    expect((await kavya.post(url(E1, '/legal-hold'), { reason: 'Fresh court order' })).status).toBe(200);
    const res1 = await runDisposal(deps, { disposalRequestId: r1.body.id });
    expect(res1.status).toBe('FAILED');
    expect(res1.reason).toMatch(/legal hold/);
    expect((await listVersions(app.storage, E1.bucket, E1.key)).length).toBe(1);
    const dr1 = await app.db.selectFrom('disposal_requests').select(['status', 'execution_error', 'execution_attempts']).where('id', '=', r1.body.id).executeTakeFirstOrThrow();
    expect(dr1).toMatchObject({ status: 'APPROVED', execution_attempts: 1 });
    expect(dr1.execution_error).toMatch(/legal hold/);

    // (b) The object store itself refuses (S3 legal hold set directly on the object; bypass cannot override it).
    const E2 = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']! });
    await retentionEnded(E2);
    const r2 = await latha.post(url(E2, '/disposal-requests'), { reason, authorityRef: 'GO-B' });
    await kavya.post(`/api/v1/evidence/disposal-requests/${r2.body.id}/approve`, { note: 'approved second' });
    await app.storage.s3.send(new PutObjectLegalHoldCommand({ Bucket: E2.bucket, Key: E2.key, VersionId: E2.versionId, LegalHold: { Status: 'ON' } }));
    const res2 = await runDisposal(deps, { disposalRequestId: r2.body.id });
    expect(res2.status).toBe('FAILED');
    expect(res2.reason).toMatch(/storage refused deletion/);
    expect((await listVersions(app.storage, E2.bucket, E2.key)).length).toBe(1);
    const ev2 = await app.db.selectFrom('evidence').select('status').where('id', '=', E2.id).executeTakeFirstOrThrow();
    expect(ev2.status).toBe('DISPOSAL_PENDING');
    const lst = (await kavya.get('/api/v1/evidence/disposal-requests?status=APPROVED&pageSize=200')).body.items.find((i: { id: string }) => i.id === r2.body.id);
    expect(lst.executionError).toMatch(/refused/);
    expect(lst.canRetry).toBe(true);
    assertNoStorageLeak(lst, [E2]);
    const failedAudit = await app.db.selectFrom('audit_events').select('outcome').where('evidence_id', '=', E2.id).where('action', '=', 'EVIDENCE_DISPOSAL_FAILED').execute();
    expect(failedAudit).toEqual([{ outcome: 'FAILURE' }]);
    // Once the storage hold is lifted, a retry succeeds.
    await app.storage.s3.send(new PutObjectLegalHoldCommand({ Bucket: E2.bucket, Key: E2.key, VersionId: E2.versionId, LegalHold: { Status: 'OFF' } }));
    const retry = await kavya.post(`/api/v1/evidence/disposal-requests/${r2.body.id}/retry`);
    expect(retry.status).toBe(202);
    expect((await runDisposal(deps, { disposalRequestId: r2.body.id })).status).toBe('EXECUTED');
  });

  it('lists disposal candidates past retention, excluding held evidence', async () => {
    const past = new Date(Date.now() - 400 * 86_400_000);
    const old = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']!, registeredAt: past, retentionPolicyCode: 'non_evidentiary' });
    const held = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['op.cubbon']!, registeredAt: past, retentionPolicyCode: 'non_evidentiary' });
    await app.db.updateTable('evidence').set({ legal_hold: true, legal_hold_reason: 'test', legal_hold_at: new Date(), legal_hold_by: U['sup.kavya']! }).where('id', '=', held.id).execute();
    const r = await (await as('ec.latha')).get('/api/v1/evidence/disposal-candidates?pageSize=200');
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(held.id);
    expect(ids).not.toContain(A.id);
    expect((await (await as('io.meera')).get('/api/v1/evidence/disposal-candidates')).status).toBe(403);
    // Still REGISTERED: candidates are never disposed automatically.
    expect((await app.db.selectFrom('evidence').select('status').where('id', '=', old.id).executeTakeFirstOrThrow()).status).toBe('REGISTERED');
  });
});

describe('tier change request', () => {
  it('queues a manual tier move for retention managers only', async () => {
    expect((await (await as('io.meera')).post(url(C, '/tier'), { targetTier: 'ARCHIVE' })).status).toBe(403);
    expect((await (await as('ec.latha')).post(url(C, '/tier'), { targetTier: 'ACTIVE' })).status).toBe(409);
    const r = await (await as('ec.latha')).post(url(C, '/tier'), { targetTier: 'ARCHIVE' });
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(true);
  });
});

describe('audit ledger', () => {
  it('hash chain verifies after all evidence operations', async () => {
    const { rows } = await sql<{ checked: number; first_bad_seq: number | null }>`SELECT * FROM audit_verify()`.execute(app.db);
    expect(Number(rows[0]!.checked)).toBeGreaterThan(10);
    expect(rows[0]!.first_bad_seq).toBeNull();
  });
});
