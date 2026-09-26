/**
 * Mass assignment (security round 2). Every create/update body is a Zod object: unknown keys are either stripped
 * before the handler runs (default) or rejected with 400 (`.strict()`, now used on the security-relevant bodies:
 * exports, shares, uploads, review decisions, AI jobs + the modules that already were strict). These tests send
 * security-relevant extra fields (status, org ids/paths, owner/creator ids, hashes, review state, permissions,
 * is_system, approval fields) to real routes and assert, in the database, that none of them took effect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { closeApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createAdmin } from './admin-helpers.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { insertDetections } from './search-support.js';
import { orgIdOf } from './security-support.js';

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let ev: CreatedEvidence;
let meeraId: string;
let naz: string;
const EVIL_USER = randomUUID();

/** Extra fields an attacker would try to smuggle into any body. */
const extras = () => ({
  status: 'APPROVED', state: 'APPROVED', org_unit_id: naz, org_path: 'ksp', orgPath: 'ksp', uploaded_by: EVIL_USER, uploadedBy: EVIL_USER,
  created_by: EVIL_USER, createdBy: EVIL_USER, owner_id: EVIL_USER, ownerId: EVIL_USER, author_id: EVIL_USER, authorId: EVIL_USER, user_id: EVIL_USER,
  userIdOverride: EVIL_USER, sha256: 'f'.repeat(64), review_status: 'APPROVED', reviewStatus: 'APPROVED', reviewed_by: EVIL_USER, permissions: ['audit:read'],
  is_system: true, isSystem: true, approved_by: EVIL_USER, approvedBy: EVIL_USER, allow_original: true, verified: true, legal_hold: true, legalHold: true,
  storage_key: 'originals/x', evidence_number: 'KSP-FAKE-1', id: randomUUID(), password_hash: 'x', mfa_enabled: false, source: 'AI',
});

beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, kavya] = await Promise.all([login('io.meera'), login('sup.kavya')]);
  meeraId = await userId('io.meera');
  naz = await orgIdOf(app, 'ps_nazarbad');
  ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: meeraId });
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const strictReject = (r: { status: number; body: { error?: { code?: string } } }) => r.status === 400 && r.body.error?.code === 'VALIDATION_FAILED';

describe('stripped (non-strict) bodies: extras never reach the database', () => {
  it('PATCH /evidence/:id changes only the declared metadata', async () => {
    const before = await app.db.selectFrom('evidence').selectAll().where('id', '=', ev.id).executeTakeFirstOrThrow();
    const r = await meera.patch(`/api/v1/evidence/${ev.id}`, { title: 'Renamed by owner', ...extras() });
    expect(r.status === 200 || strictReject(r)).toBe(true);
    const after = await app.db.selectFrom('evidence').selectAll().where('id', '=', ev.id).executeTakeFirstOrThrow();
    for (const k of ['sha256', 'sha512', 'status', 'org_unit_id', 'org_path', 'uploaded_by', 'legal_hold', 'storage_key', 'evidence_number', 'officer_id'] as const) {
      expect({ k, v: after[k] }).toEqual({ k, v: before[k] });
    }
  });

  it('POST /cases: status, org, creator and number are server-controlled', async () => {
    const r = await meera.post('/api/v1/cases', { title: `MA case ${Date.now()}`, ...extras(), caseNumber: 'FAKE-1', case_number: 'FAKE-1' });
    if (strictReject(r)) return;
    expect(r.status).toBe(201);
    const c = await app.db.selectFrom('cases').selectAll().where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(c.status).toBe('OPEN');
    expect(c.created_by).toBe(meeraId);
    expect(c.org_unit_id).not.toBe(naz);
    expect(c.case_number).not.toBe('FAKE-1');
  });

  it('POST /cases/:id/notes, /workspaces, /workspaces/annotations, /search/saved, /evidence/:id/tags keep the real author/owner', async () => {
    const c = (await meera.post('/api/v1/cases', { title: `MA case 2 ${Date.now()}` })).body.id as string;
    const note = await meera.post(`/api/v1/cases/${c}/notes`, { body: 'note', ...extras() });
    if (!strictReject(note)) expect((await app.db.selectFrom('case_notes').select('author_id').where('id', '=', note.body.id).executeTakeFirstOrThrow()).author_id).toBe(meeraId);
    const ws = await meera.post('/api/v1/workspaces', { title: `MA ws ${Date.now()}`, ...extras() });
    if (!strictReject(ws)) {
      const w = await app.db.selectFrom('workspaces').selectAll().where('id', '=', ws.body.id).executeTakeFirstOrThrow();
      expect([w.owner_id, w.status]).toEqual([meeraId, 'ACTIVE']);
    }
    const an = await meera.post('/api/v1/workspaces/annotations', { evidenceId: ev.id, kind: 'NOTE', startMs: 0, body: 'x', ...extras() });
    if (!strictReject(an)) expect((await app.db.selectFrom('annotations').select('author_id').where('id', '=', an.body.id).executeTakeFirstOrThrow()).author_id).toBe(meeraId);
    const ss = await meera.post('/api/v1/search/saved', { name: `MA ss ${Date.now()}`, criteria: {}, ...extras() });
    if (!strictReject(ss)) expect((await app.db.selectFrom('saved_searches').select('user_id').where('id', '=', ss.body.id).executeTakeFirstOrThrow()).user_id).toBe(meeraId);
    const tag = await meera.post(`/api/v1/evidence/${ev.id}/tags`, { tag: 'ma-tag', ...extras() });
    if (!strictReject(tag)) {
      const t = await app.db.selectFrom('evidence_tags').selectAll().where('evidence_id', '=', ev.id).where('tag', '=', 'ma-tag').executeTakeFirstOrThrow();
      expect([t.source, t.created_by]).toEqual(['MANUAL', meeraId]);
    }
  });
});

describe('strict bodies: extras are rejected (400)', () => {
  it('exports, shares, uploads, review decisions and AI jobs refuse unknown fields', async () => {
    const cubbon = await orgIdOf(app, 'ps_cubbonpark');
    const cases: Array<[Agent, string, unknown]> = [
      [meera, '/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Mass assignment probe', options: { includeWatermarked: true, includeOriginal: false }, status: 'APPROVED', approvedBy: EVIL_USER }],
      [meera, '/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Mass assignment probe', options: { includeWatermarked: true, includeOriginal: false, skipApproval: true } }],
      [meera, '/api/v1/shares', { evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: await userId('sup.kavya'), purpose: 'Mass assignment probe', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: 'ACTIVE', createdBy: EVIL_USER }],
      [meera, '/api/v1/uploads', { orgUnitId: cubbon, filename: 'x.mp4', size: 1000, created_by: EVIL_USER, status: 'COMPLETED' }],
      [meera, '/api/v1/uploads/batches', { orgUnitId: cubbon, createdBy: EVIL_USER }],
      [meera, `/api/v1/ai/evidence/${ev.id}/jobs`, { tasks: ['PERSON_DETECTION'], requestedBy: EVIL_USER, status: 'COMPLETED' }],
    ];
    const det = (await insertDetections(ev.id, meeraId, [{ label: 'car', reviewStatus: 'PENDING' }]))[0]!;
    cases.push([kavya, `/api/v1/review/detections/${det}`, { action: 'APPROVE', review_status: 'APPROVED', reviewedBy: EVIL_USER }]);
    cases.push([kavya, '/api/v1/review/detections/bulk', { items: [{ id: det, action: 'APPROVE', reviewStatus: 'APPROVED' }] }]);
    for (const [who, url, body] of cases) {
      const r = await who.post(url, body);
      expect({ url, strict: strictReject(r) }).toEqual({ url, strict: true });
    }
    expect((await app.db.selectFrom('ai_detections').select('review_status').where('id', '=', det).executeTakeFirstOrThrow()).review_status).toBe('PENDING');
    // …and the same bodies WITHOUT the extras are accepted (the web and station client send exactly these keys).
    expect((await meera.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Mass assignment probe', options: { includeWatermarked: true, includeOriginal: false } })).status).toBe(201);
  });
});

describe('administration bodies', () => {
  it('POST /roles cannot mint a system role; PATCH /users cannot change status/password/MFA/roles', async () => {
    const admin = await createAdmin();
    const role = await admin.agent.post('/api/v1/roles', { code: `MA_${Date.now().toString(36).toUpperCase()}`, name: 'Mass assignment role', permissions: ['dashboard:view'], is_system: true, isSystem: true });
    if (!strictReject(role)) {
      expect(role.status).toBe(201);
      expect((await app.db.selectFrom('roles').select('is_system').where('id', '=', role.body.id).executeTakeFirstOrThrow()).is_system).toBe(false);
    }
    const target = await app.db.selectFrom('users').select(['id', 'status', 'password_hash', 'mfa_enabled', 'must_change_password']).where('username', '=', 'fo.ravi').executeTakeFirstOrThrow();
    const r = await admin.agent.patch(`/api/v1/users/${target.id}`, { fullName: 'Ravi Kumar', status: 'DISABLED', passwordHash: 'x', password_hash: 'x', mfaEnabled: true, roles: [{ roleCode: 'SYSTEM_ADMINISTRATOR' }], mustChangePassword: true });
    expect(r.status === 200 || strictReject(r)).toBe(true);
    const after = await app.db.selectFrom('users').select(['id', 'status', 'password_hash', 'mfa_enabled', 'must_change_password']).where('id', '=', target.id).executeTakeFirstOrThrow();
    expect(after).toEqual(target);
    const roles = await app.db.selectFrom('user_roles as ur').innerJoin('roles as r', 'r.id', 'ur.role_id').select('r.code').where('ur.user_id', '=', target.id).execute();
    expect(roles.map((x) => x.code)).toEqual(['FIELD_OFFICER']);
  });
});
