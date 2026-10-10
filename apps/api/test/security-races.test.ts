/**
 * Race conditions (security round 2): concurrent approvals of the same export / disposal request by two approvers,
 * concurrent self-approval attempts, concurrent upload completion, concurrent refresh-token rotation, concurrent
 * use of one MFA recovery code. Every check fires the requests truly in parallel (Promise.all on inject).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { decryptSecret } from '@ksp/core';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { auditRows, userWithPerms } from './custody-support.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { orgId, putPart, readChunk, smallVideo, sha256File, initUpload } from './uploads-support.js';

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let kavya2: Agent; // second SUPERVISOR at blr_central
let latha: Agent;

beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, kavya, latha] = await Promise.all(['io.meera', 'sup.kavya', 'ec.latha'].map((u) => login(u)));
  kavya2 = await login((await createUser({ role: 'SUPERVISOR', org: 'blr_central' })).username);
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const statuses = (rs: Array<{ status: number }>) => rs.map((r) => r.status).sort();

describe('export approval races', () => {
  it('two approvers approving the same export concurrently: exactly one wins', async () => {
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    const x = await meera.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Race test export purpose', courtName: 'City Civil Court', options: { includeOriginal: false, includeWatermarked: true } });
    expect(x.status).toBe(201);
    const rs = await Promise.all([kavya, kavya2, kavya, kavya2].map((a) => a.post(`/api/v1/exports/${x.body.id}/approve`, { note: 'race' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    const ok = (await auditRows({ action: 'EXPORT_APPROVED', evidenceId: ev.id })).filter((a) => a.outcome === 'SUCCESS');
    expect(ok).toHaveLength(1);
    const row = await app.db.selectFrom('exports').select(['status', 'approved_by']).where('id', '=', x.body.id).executeTakeFirstOrThrow();
    expect(row.status).not.toBe('PENDING_APPROVAL');
  });

  it('approve vs reject concurrently: one decision only', async () => {
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    const x = await meera.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Race test export purpose', courtName: 'City Civil Court', options: { includeOriginal: false, includeWatermarked: true } });
    const rs = await Promise.all([kavya.post(`/api/v1/exports/${x.body.id}/approve`, { note: 'ok' }), kavya2.post(`/api/v1/exports/${x.body.id}/reject`, { note: 'not needed any more' })]);
    expect(statuses(rs)).toEqual([200, 409]);
  });

  it('concurrent self-approval attempts are all refused (SoD) and nothing is approved', async () => {
    const both = await login((await userWithPerms(['export:create', 'export:approve', 'evidence:read', 'evidence:play', 'custody:read'], 'ps_cubbonpark')).username);
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    const x = await both.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Self approval attempt', courtName: 'City Civil Court', options: { includeOriginal: false, includeWatermarked: true } });
    expect(x.status).toBe(201);
    const rs = await Promise.all(Array.from({ length: 6 }, () => both.post(`/api/v1/exports/${x.body.id}/approve`, { note: 'self' })));
    expect(rs.every((r) => r.status === 403 && r.body.error.code === 'SEPARATION_OF_DUTIES')).toBe(true);
    expect((await app.db.selectFrom('exports').select('status').where('id', '=', x.body.id).executeTakeFirstOrThrow()).status).toBe('PENDING_APPROVAL');
  });
});

describe('disposal approval races', () => {
  const reason = 'Retention period expired per the retention schedule';
  it('two approvers + a rejecter concurrently: exactly one decision', async () => {
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    await app.db.updateTable('evidence').set({ retain_until: new Date(Date.now() - 86_400_000) }).where('id', '=', ev.id).execute(); // retention ended
    const dr = await latha.post(`/api/v1/evidence/${ev.id}/disposal-requests`, { reason, authorityRef: 'GO-RACE-1' });
    expect(dr.status).toBe(201);
    const rs = await Promise.all([
      kavya.post(`/api/v1/evidence/disposal-requests/${dr.body.id}/approve`, { note: 'approve A' }),
      kavya2.post(`/api/v1/evidence/disposal-requests/${dr.body.id}/approve`, { note: 'approve B' }),
      kavya2.post(`/api/v1/evidence/disposal-requests/${dr.body.id}/reject`, { note: 'reject C' }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    const decided = (await auditRows({ evidenceId: ev.id })).filter((a) => ['EVIDENCE_DISPOSAL_APPROVED', 'EVIDENCE_DISPOSAL_REJECTED'].includes(a.action));
    expect(decided).toHaveLength(1);
  });

  it('concurrent self-approval of a disposal request is refused', async () => {
    const both = await login((await userWithPerms(['evidence:read', 'evidence:dispose_request', 'evidence:dispose_approve'], 'ps_cubbonpark')).username);
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    await app.db.updateTable('evidence').set({ retain_until: new Date(Date.now() - 86_400_000) }).where('id', '=', ev.id).execute(); // retention ended
    const dr = await both.post(`/api/v1/evidence/${ev.id}/disposal-requests`, { reason, authorityRef: 'GO-RACE-2' });
    expect(dr.status).toBe(201);
    const rs = await Promise.all(Array.from({ length: 5 }, () => both.post(`/api/v1/evidence/disposal-requests/${dr.body.id}/approve`, { note: 'self' })));
    expect(rs.every((r) => r.status === 403)).toBe(true);
    expect((await app.db.selectFrom('disposal_requests').select('status').where('id', '=', dr.body.id).executeTakeFirstOrThrow()).status).toBe('PENDING');
  });
});

describe('upload completion race', () => {
  it('concurrent completes register exactly one evidence item (SEC-10)', async () => {
    const clip = await smallVideo(`race-${Date.now()}.mp4`, 2);
    const init = await initUpload(meera, clip, { orgUnitId: await orgId(app, 'ps_cubbonpark'), sha256: sha256File(clip) });
    expect(init.status).toBe(201);
    const { id, chunkSize, totalChunks } = init.body;
    for (let n = 1; n <= totalChunks; n++) expect((await putPart(meera, id, n, readChunk(clip, chunkSize, n))).status).toBe(200);
    const rs = await Promise.all(Array.from({ length: 6 }, () => meera.post(`/api/v1/uploads/${id}/complete`)));
    const rows = await app.db.selectFrom('evidence').select('id').where('upload_session_id', '=', id).execute();
    console.log('complete race statuses', statuses(rs), 'evidence rows', rows.length);
    expect(rows).toHaveLength(1);
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    const s = await app.db.selectFrom('upload_sessions').select(['status', 'evidence_id']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(s).toEqual({ status: 'COMPLETED', evidence_id: rows[0]!.id });
    expect((await auditRows({ action: 'EVIDENCE_RECEIVED', resourceId: rows[0]!.id }))).toHaveLength(1);
  });

  it('concurrent uploads of the same part keep a consistent session', async () => {
    const clip = await smallVideo(`race-part-${Date.now()}.mp4`, 4);
    const init = await initUpload(meera, clip, { orgUnitId: await orgId(app, 'ps_cubbonpark'), sha256: sha256File(clip) });
    const { id, chunkSize } = init.body;
    const buf = readChunk(clip, chunkSize, 1);
    const rs = await Promise.all(Array.from({ length: 5 }, () => putPart(meera, id, 1, buf)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const parts = await app.db.selectFrom('upload_parts').select(['part_number', 'size_bytes']).where('session_id', '=', id).execute();
    expect(parts).toHaveLength(1);
    const s = await app.db.selectFrom('upload_sessions').select(['received_bytes']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(Number(s.received_bytes)).toBe(buf.length);
    expect((await meera.post(`/api/v1/uploads/${id}/complete`)).status).toBe(200);
    await meera.delete(`/api/v1/uploads/${id}`);
  });
});

describe('refresh token rotation race', () => {
  it('N concurrent refreshes with one token: exactly one rotates, the replay revokes the family + session', async () => {
    const a = new Agent(app);
    const l = await a.post('/api/v1/auth/login', { username: 'io.meera', password: 'Ksp@Dev-Passw0rd!', tokenMode: 'bearer' });
    expect(l.status).toBe(200);
    const rt = l.body.refreshToken as string;
    const rs = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: rt } })));
    const ok = rs.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 401)).toHaveLength(5);
    // Reuse detected => the winner's new refresh token and access token are dead too.
    const winner = ok[0]!.json() as { accessToken: string; refreshToken: string };
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: winner.refreshToken } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${winner.accessToken}` } })).statusCode).toBe(401);
    const sid = l.body.me.sessionId as string;
    const s = await app.db.selectFrom('sessions').select(['revoked_at', 'revoke_reason']).where('id', '=', sid).executeTakeFirstOrThrow();
    expect(s.revoke_reason).toBe('REFRESH_TOKEN_REUSE');
    expect((await auditRows({ action: 'TOKEN_REUSE_DETECTED', resourceId: sid })).length).toBeGreaterThanOrEqual(1);
  });
});

describe('MFA recovery code race', () => {
  it('one recovery code used concurrently yields exactly one session (SEC-12)', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const ag = await login(u.username);
    const setup = await ag.post('/api/v1/auth/mfa/setup');
    const conf = await ag.post('/api/v1/auth/mfa/confirm', { code: authenticator.generate(setup.body.secret) });
    expect(conf.status).toBe(200);
    const code = conf.body.recoveryCodes[0] as string;
    const tokens = await Promise.all(Array.from({ length: 4 }, async () => (await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: u.password })).body.mfaToken as string));
    const rs = await Promise.all(tokens.map((t) => app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken: t, recoveryCode: code, tokenMode: 'bearer' } })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const row = await app.db.selectFrom('users').select(['mfa_recovery_codes', 'mfa_secret_enc']).where('id', '=', u.id).executeTakeFirstOrThrow();
    expect(row.mfa_recovery_codes).toHaveLength(9);
    void decryptSecret;
  });
});
