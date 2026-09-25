/**
 * Audit viewer & compliance: authz + scope, filters + keyset pagination, throttled AUDIT_VIEWED, CSV/JSON
 * export with file hash, ledger verification, signed checkpoints (valid + mismatch detection), and — LAST —
 * tamper detection by modifying a ledger row as the migration (owner) role with the trigger disabled, then
 * restoring the exact original bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { evidenceSigner } from '@ksp/core';
import { checkpointPayload } from '@ksp/core/custody';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { userWithPerms } from './custody-support.js';

let app: FastifyInstance;
let auditor: Agent;
let meera: Agent;
let districtAuditor: Agent;
let evId: string;
let otherEvId: string;

beforeAll(async () => {
  app = await evidenceTestSetup();
  auditor = await login('aud.suresh');
  meera = await login('io.meera');
  districtAuditor = await login((await userWithPerms(['audit:read', 'audit:export'], 'blr_central')).username);
  const uploader = (await app.db.selectFrom('users').select('id').where('username', '=', 'io.meera').executeTakeFirstOrThrow()).id;
  evId = (await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: uploader })).id;
  otherEvId = (await createRegisteredEvidence({ orgCode: 'ps_nazarbad', uploadedBy: uploader })).id;
  // A few evidence-linked events.
  for (let i = 0; i < 3; i++) expect((await meera.get(`/api/v1/evidence/${evId}`)).status).toBe(200);
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const anon = () => new Agent(app);

describe('audit viewer', () => {
  it('authz: 401 anonymous, 403 without audit:read (IO), auditor 200', async () => {
    expect((await anon().get('/api/v1/audit/events')).status).toBe(401);
    expect((await meera.get('/api/v1/audit/events')).status).toBe(403);
    expect((await meera.post('/api/v1/audit/export', { format: 'csv' })).status).toBe(403);
    expect((await meera.post('/api/v1/audit/verify', {})).status).toBe(403);
    expect((await meera.get('/api/v1/audit/checkpoints')).status).toBe(403);
    expect((await auditor.get('/api/v1/audit/events')).status).toBe(200);
  });

  it('filters by evidence and action; keyset pagination by seq without gaps or overlap', async () => {
    const all = await auditor.get(`/api/v1/audit/events?evidenceId=${evId}&limit=200`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(4);
    expect(all.body.items.every((e: { evidenceId: string }) => e.evidenceId === evId)).toBe(true);
    const views = await auditor.get(`/api/v1/audit/events?evidenceId=${evId}&action=EVIDENCE_VIEWED`);
    expect(views.body.items.length).toBe(3);
    const pages: number[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { items: Array<{ seq: number }>; nextCursor: string | null } } = await auditor.get(`/api/v1/audit/events?evidenceId=${evId}&limit=2${cursor ? `&before=${cursor}` : ''}`);
      pages.push(...r.body.items.map((e) => e.seq));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(pages).toEqual(all.body.items.map((e: { seq: number }) => e.seq));
    expect([...pages].sort((a, b) => b - a)).toEqual(pages);
    const q = await auditor.get(`/api/v1/audit/events?q=${encodeURIComponent('fixture')}&evidenceId=${evId}`);
    expect(q.body.items.map((e: { action: string }) => e.action)).toContain('EVIDENCE_REGISTERED');
  });

  it('event detail shows hash / prev_hash and verifies the row', async () => {
    const list = await auditor.get(`/api/v1/audit/events?evidenceId=${evId}&limit=1`);
    const seq = list.body.items[0].seq;
    const r = await auditor.get(`/api/v1/audit/events/${seq}`);
    expect(r.status).toBe(200);
    expect(r.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.verification).toEqual({ hashOk: true, linkOk: true, verified: true });
    expect((await auditor.get('/api/v1/audit/events/999999999')).status).toBe(404);
  });

  it('scope: a district-level auditor only sees events of units in their subtree', async () => {
    const mine = await districtAuditor.get(`/api/v1/audit/events?evidenceId=${evId}`);
    expect(mine.body.items.length).toBeGreaterThan(0);
    const other = await districtAuditor.get(`/api/v1/audit/events?evidenceId=${otherEvId}`);
    expect(other.body.items.length).toBe(0);
    const state = await auditor.get(`/api/v1/audit/events?evidenceId=${otherEvId}`);
    expect(state.body.items.length).toBeGreaterThan(0);
  });

  it('writes AUDIT_VIEWED at most once per window', async () => {
    const u = await createUser({ role: 'AUDITOR', org: 'ksp' });
    const a = await login(u.username);
    await a.get('/api/v1/audit/events');
    await a.get('/api/v1/audit/events?limit=5');
    const n = await app.db.selectFrom('audit_events').select((eb) => eb.fn.countAll().as('n')).where('action', '=', 'AUDIT_VIEWED').where('actor_id', '=', u.id).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });
});

describe('audit export', () => {
  it('CSV export: stored, hash returned equals the hash of the downloaded file, audited', async () => {
    const r = await auditor.post('/api/v1/audit/export', { format: 'csv', filters: { evidenceId: evId } });
    expect(r.status).toBe(201);
    expect(r.body.rowCount).toBeGreaterThanOrEqual(4);
    const dl = await app.inject({ method: 'GET', url: r.body.downloadUrl, headers: { cookie: [...auditor.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    expect(dl.statusCode).toBe(200);
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(r.body.sha256);
    expect(dl.headers['x-content-sha256']).toBe(r.body.sha256);
    const lines = dl.rawPayload.toString('utf8').trim().split('\n');
    expect(lines[0]).toBe('seq,event_id,occurred_at,actor_type,actor_id,actor_name,actor_ip,action,category,outcome,resource_type,resource_id,evidence_id,case_id,org_unit_id,details,prev_hash,hash');
    expect(lines.length).toBe(r.body.rowCount + 1);
    const audit = await app.db.selectFrom('audit_events').select(['details']).where('action', '=', 'AUDIT_EXPORTED').where('resource_id', '=', r.body.id).executeTakeFirstOrThrow();
    expect((audit.details as { sha256: string }).sha256).toBe(r.body.sha256);
    // Only the creator can download.
    const other = await login((await createUser({ role: 'AUDITOR', org: 'ksp' })).username);
    expect((await other.get(r.body.downloadUrl)).status).toBe(404);
  });

  it('JSON export parses and carries every event with hashes', async () => {
    const r = await auditor.post('/api/v1/audit/export', { format: 'json', filters: { evidenceId: evId } });
    expect(r.status).toBe(201);
    const dl = await app.inject({ method: 'GET', url: r.body.downloadUrl, headers: { cookie: [...auditor.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const doc = JSON.parse(dl.rawPayload.toString('utf8'));
    expect(doc.type).toBe('KSP-AUDIT-EXPORT');
    expect(doc.events.length).toBe(r.body.rowCount);
    expect(doc.events[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ledger verification and checkpoints', () => {
  it('verifies the full chain', async () => {
    const r = await auditor.post('/api/v1/audit/verify', {});
    expect(r.status).toBe(200);
    expect(r.body.chainOk).toBe(true);
    expect(r.body.firstBadSeq).toBeNull();
    expect(r.body.checked).toBe(r.body.headSeq);
  });

  it('creates a signed checkpoint whose signature and head verify', async () => {
    const c = await auditor.post('/api/v1/audit/checkpoints', {});
    expect(c.status).toBe(201);
    expect(c.body.created).toBe(true);
    const id = c.body.checkpoint.id;
    const v = await auditor.get(`/api/v1/audit/checkpoints/${id}/verify`);
    expect(v.status).toBe(200);
    expect(v.body.signatureValid).toBe(true);
    expect(v.body.headMatches).toBe(true);
    expect(v.body.ok).toBe(true);
    const list = await auditor.get('/api/v1/audit/checkpoints');
    expect(list.body.items[0].id).toBe(id);
    // Offline check of the exported payload with the published certificate.
    const ex = await auditor.get('/api/v1/audit/checkpoints/export');
    const cp = ex.body.checkpoints.find((x: { id: number }) => x.id === id);
    expect(evidenceSigner().verify(Buffer.from(cp.payload, 'utf8'), cp.signature, ex.body.signingCertificate)).toBe(true);
    const all = await auditor.post('/api/v1/audit/verify', {});
    expect(all.body.checkpoints.find((x: { id: number }) => x.id === id)).toMatchObject({ signatureValid: true, headMatches: true });
  });

  it('detects a checkpoint whose head hash does not match the ledger, and a forged signature', async () => {
    const head = await app.db.selectFrom('audit_events').select(['seq']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    const createdAt = new Date();
    const wrongHash = 'f'.repeat(64);
    const sig = await evidenceSigner().sign(Buffer.from(checkpointPayload({ headSeq: Number(head.seq), headHash: wrongHash, createdAt, keyId: 'ksp-dev-signing-key' })));
    const a = await app.db.insertInto('audit_checkpoints').values({ head_seq: head.seq, head_hash: wrongHash, created_at: createdAt, key_id: sig.keyId, algorithm: sig.algorithm, signature: sig.signature }).returning('id').executeTakeFirstOrThrow();
    const va = await auditor.get(`/api/v1/audit/checkpoints/${a.id}/verify`);
    expect(va.body.signatureValid).toBe(sig.keyId === 'ksp-dev-signing-key');
    expect(va.body.headMatches).toBe(false);
    expect(va.body.ok).toBe(false);
    const real = await app.db.selectFrom('audit_events').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    const b = await app.db.insertInto('audit_checkpoints').values({ head_seq: real.seq, head_hash: real.hash, created_at: new Date(), key_id: 'ksp-dev-signing-key', algorithm: sig.algorithm, signature: Buffer.from('forged-signature-bytes').toString('base64') }).returning('id').executeTakeFirstOrThrow();
    const vb = await auditor.get(`/api/v1/audit/checkpoints/${b.id}/verify`);
    expect(vb.body.signatureValid).toBe(false);
    expect(vb.body.headMatches).toBe(true);
    expect(vb.body.ok).toBe(false);
    const all = await auditor.post('/api/v1/audit/verify', {});
    expect(all.body.checkpointsOk).toBe(false);
    expect(all.body.ok).toBe(false);
  });
});

describe('tamper detection (runs last; the modified row is restored byte-for-byte)', () => {
  it('a row modified by a superuser bypassing the trigger breaks custody + ledger verification and raises AUDIT_CHAIN_BROKEN', async () => {
    const target = await app.db.selectFrom('audit_events').select(['seq', 'details']).where('evidence_id', '=', evId).where('action', '=', 'EVIDENCE_VIEWED').orderBy('seq').limit(1).executeTakeFirstOrThrow();
    const seq = Number(target.seq);
    // The app role cannot touch the ledger at all.
    await expect(app.db.updateTable('audit_events').set({ details: JSON.stringify({ x: 1 }) }).where('seq', '=', seq).execute()).rejects.toThrow();
    const owner = new pg.Client({ connectionString: app.cfg.DATABASE_MIGRATION_URL });
    await owner.connect();
    const original = (await owner.query<{ d: string }>('SELECT details::text AS d FROM audit_events WHERE seq = $1', [seq])).rows[0]!.d;
    try {
      await owner.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await owner.query(`UPDATE audit_events SET details = details || '{"tampered": true}'::jsonb WHERE seq = $1`, [seq]);
      await owner.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');

      const c = await meera.get(`/api/v1/custody/evidence/${evId}`);
      expect(c.body.verification.chainIntact).toBe(false);
      expect(c.body.verification.brokenSeqs).toContain(seq);
      expect(c.body.events.find((e: { seq: number }) => e.seq === seq).verified).toBe(false);

      const v = await auditor.post('/api/v1/audit/verify', {});
      expect(v.body.chainOk).toBe(false);
      expect(v.body.firstBadSeq).toBe(seq);
      const alert = await app.db.selectFrom('alerts').selectAll().where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').where('resource_id', '=', String(seq)).executeTakeFirst();
      expect(alert?.severity).toBe('CRITICAL');
      const d = await auditor.get(`/api/v1/audit/events/${seq}`);
      expect(d.body.verification.hashOk).toBe(false);
    } finally {
      await owner.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await owner.query('UPDATE audit_events SET details = $2::jsonb WHERE seq = $1', [seq, original]);
      await owner.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      await owner.end();
    }
    const restored = await meera.get(`/api/v1/custody/evidence/${evId}`);
    expect(restored.body.verification.chainIntact).toBe(true);
    const v2 = await auditor.post('/api/v1/audit/verify', {});
    expect(v2.body.chainOk).toBe(true);
  });
});
