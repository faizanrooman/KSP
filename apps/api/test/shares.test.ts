/**
 * Secure sharing (internal + external share management): authz, internal share grants then revokes
 * visibility, download permission rules, expiry limits, secrets returned once and stored hashed, lists,
 * revoke rules, shares.expire cron.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256Hex } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { auditRows } from './custody-support.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { runSharesExpire } from '../../worker/src/jobs/shares/index.js';

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let arjun: Agent;
let ravi: Agent;
let mysuru: Agent;
let ev: CreatedEvidence;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

beforeAll(async () => {
  app = await evidenceTestSetup();
  ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  [meera, kavya, arjun, ravi, mysuru] = await Promise.all(['io.meera', 'sup.kavya', 'io.arjun', 'fo.ravi', 'io.mysuru'].map((u) => login(u)));
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const anon = () => new Agent(app);
const internal = async (extra: Record<string, unknown> = {}) => ({ evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: await userId('io.mysuru'), purpose: 'Assist the Mysuru investigation', expiresAt: inDays(2), ...extra });
const external = (extra: Record<string, unknown> = {}) => ({ evidenceIds: [ev.id], recipientType: 'EXTERNAL', recipientName: 'Adv. R. Prakash', recipientEmail: 'pp.office@example.org', recipientOrg: 'Public Prosecutor, CCH-1', purpose: 'Review before trial', expiresAt: inDays(3), ...extra });

describe('share creation rules', () => {
  it('authz: 401 anonymous, 403 without share:create, 404 other jurisdiction', async () => {
    expect((await anon().post('/api/v1/shares', await internal())).status).toBe(401);
    expect((await ravi.post('/api/v1/shares', await internal())).status).toBe(403);
    expect((await arjun.post('/api/v1/shares', await internal())).status).toBe(404);
    expect((await anon().get('/api/v1/shares')).status).toBe(401);
  });

  it('validates expiry against settings.maxShareDays and recipient fields', async () => {
    expect((await meera.post('/api/v1/shares', await internal({ expiresAt: inDays(31) }))).status).toBe(400);
    expect((await meera.post('/api/v1/shares', await internal({ expiresAt: inDays(-1) }))).status).toBe(400);
    expect((await meera.post('/api/v1/shares', external({ recipientEmail: undefined }))).status).toBe(400);
    expect((await meera.post('/api/v1/shares', await internal({ recipientUserId: await userId('io.meera') }))).status).toBe(400);
  });

  it('allowDownload requires the sharer to hold evidence:download_original', async () => {
    const r = await meera.post('/api/v1/shares', await internal({ allowDownload: true }));
    expect(r.status).toBe(403);
    expect((await auditRows({ evidenceId: ev.id, action: 'EVIDENCE_ACCESS_DENIED' })).length).toBeGreaterThan(0);
    // unwatermarked external shares need it too
    expect((await meera.post('/api/v1/shares', external({ watermark: false }))).status).toBe(403);
    expect((await meera.post('/api/v1/shares', external({ allowOriginal: true }))).status).toBe(400);
  });
});

describe('internal shares', () => {
  it('grant visibility to the recipient; revoke removes it immediately', async () => {
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(404);
    const r = await meera.post('/api/v1/shares', await internal());
    expect(r.status).toBe(201);
    expect(r.body.token).toBeUndefined();
    expect(r.body.accessCode).toBeUndefined();
    const id = r.body.share.id;
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200);
    expect((await mysuru.get(`/api/v1/custody/evidence/${ev.id}`)).status).toBe(200);
    expect((await mysuru.get(`/api/v1/media/evidence/${ev.id}/original`)).status).toBe(403); // no download granted
    const recv = await mysuru.get('/api/v1/shares?view=received');
    expect(recv.body.items.map((s: { id: string }) => s.id)).toContain(id);
    const asRecipient = await mysuru.get(`/api/v1/shares/${id}`);
    expect(asRecipient.status).toBe(200);
    expect(asRecipient.body.accessLog).toEqual([]);
    expect((await mysuru.post(`/api/v1/shares/${id}/revoke`, { reason: 'I do not need it' })).status).toBe(403);
    expect((await arjun.post(`/api/v1/shares/${id}/revoke`, { reason: 'Not mine at all' })).status).toBe(404);
    const rv = await meera.post(`/api/v1/shares/${id}/revoke`, { reason: 'Investigation transferred' });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe('REVOKED');
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(404);
    expect((await meera.post(`/api/v1/shares/${id}/revoke`, { reason: 'Investigation transferred' })).status).toBe(409);
    expect((await auditRows({ resourceId: id, action: 'SHARE_CREATED' })).map((a) => a.evidence_id)).toEqual([ev.id]);
    expect((await auditRows({ resourceId: id, action: 'SHARE_REVOKED' })).length).toBe(1);
  });

  it('a download-enabled share from a supervisor lets the recipient download the original', async () => {
    const r = await kavya.post('/api/v1/shares', await internal({ allowDownload: true }));
    expect(r.status).toBe(201);
    expect((await mysuru.get(`/api/v1/media/evidence/${ev.id}/original`)).status).toBe(200);
    await kavya.post(`/api/v1/shares/${r.body.share.id}/revoke`, { reason: 'Done with the review' });
    expect((await mysuru.get(`/api/v1/media/evidence/${ev.id}/original`)).status).toBe(404);
  });
});

describe('external shares', () => {
  it('returns link + access code ONCE; stores only hashes; detail never exposes them', async () => {
    const r = await meera.post('/api/v1/shares', external());
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r.body.accessCode).toMatch(/^\d{8}$/);
    expect(r.body.link).toBe(`${app.cfg.APP_BASE_URL.replace(/\/$/, '')}/s/${r.body.token}`);
    const row = await app.db.selectFrom('shares').select(['token_hash', 'access_code_hash']).where('id', '=', r.body.share.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(sha256Hex(r.body.token));
    expect(row.access_code_hash).toMatch(/^\$argon2id\$/);
    const d = await meera.get(`/api/v1/shares/${r.body.share.id}`);
    expect(d.status).toBe(200);
    const text = JSON.stringify(d.body);
    expect(text).not.toContain(r.body.token);
    expect(text).not.toContain(r.body.accessCode);
    expect(text).not.toMatch(/token_hash|access_code_hash|tokenHash/);
    const created = await auditRows({ resourceId: r.body.share.id, action: 'SHARE_CREATED' });
    expect(JSON.stringify(created.map((c) => c.details))).not.toContain(r.body.accessCode);
    expect(JSON.stringify(created.map((c) => c.details))).not.toContain(r.body.token);
  });

  it('lists: mine, all (share:manage_all in scope only)', async () => {
    const mine = await meera.get('/api/v1/shares?view=mine');
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBeGreaterThanOrEqual(2);
    expect((await meera.get('/api/v1/shares?view=all')).status).toBe(403);
    const all = await kavya.get('/api/v1/shares?view=all');
    expect(all.body.total).toBeGreaterThanOrEqual(mine.body.total);
    const other = await login((await (await import('./helpers.js')).createUser({ role: 'SUPERVISOR', org: 'mysuru_dist' })).username);
    expect((await other.get('/api/v1/shares?view=all')).body.total).toBe(0);
    const byEv = await kavya.get(`/api/v1/shares?view=all&evidenceId=${ev.id}&status=REVOKED`);
    expect(byEv.body.items.every((s: { status: string }) => s.status === 'REVOKED')).toBe(true);
  });

  it('shares.expire marks overdue shares EXPIRED with a custody event', async () => {
    const r = await meera.post('/api/v1/shares', external());
    await app.db.updateTable('shares').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', r.body.share.id).execute();
    expect((await meera.get(`/api/v1/shares/${r.body.share.id}`)).body.status).toBe('EXPIRED');
    const res = await runSharesExpire({ db: app.db, storage: app.storage });
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await app.db.selectFrom('shares').select('status').where('id', '=', r.body.share.id).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
    expect((await auditRows({ resourceId: r.body.share.id, action: 'SHARE_EXPIRED' })).length).toBe(1);
  });
});
