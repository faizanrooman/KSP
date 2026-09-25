import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import {
  appendAudit, createDb, dispatchPendingAlerts, getQueue, loadConfig, raiseAlert, stopQueue, storage, webhookChannel, type Database,
} from '@ksp/core';
import { createRegisteredEvidence, type CreatedEvidence } from '../../api/test/fixtures/evidence.js';
import { evaluateRule } from '../src/jobs/alerts/index.js';

let db: Database;
let owner: pg.Client;
let uploader: string;
let adminId: string;
let kavyaId: string;
let meeraId: string;
let orgs: Record<string, { id: string; path: string }>;
let ev: CreatedEvidence;

const alertsFor = (key: string) => db.selectFrom('alerts').selectAll().where('dedupe_key', '=', key).orderBy('first_seen_at').execute();
const setRule = (code: string, patch: { enabled?: boolean; severity?: string; config?: object }) =>
  db.updateTable('alert_rules').set({ ...patch, ...(patch.config ? { config: JSON.stringify(patch.config) } : {}) }).where('code', '=', code).execute();

beforeAll(async () => {
  const cfg = loadConfig();
  db = createDb(cfg.DATABASE_URL, 4).db;
  await getQueue();
  owner = new pg.Client({ connectionString: cfg.DATABASE_MIGRATION_URL });
  await owner.connect();
  const id = async (u: string) => (await db.selectFrom('users').select('id').where('username', '=', u).executeTakeFirstOrThrow()).id;
  uploader = await id('op.cubbon');
  adminId = await id('admin');
  kavyaId = await id('sup.kavya');
  meeraId = await id('io.meera');
  const units = await db.selectFrom('org_units').select(['id', 'code', 'path']).execute();
  orgs = Object.fromEntries(units.map((u) => [u.code, { id: u.id, path: u.path }]));
  ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
}, 120_000);

afterAll(async () => {
  await owner.end();
  await stopQueue();
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom('notifications').execute();
  await db.deleteFrom('alerts').execute();
  await db.deleteFrom('alert_cursors').execute();
  await sql`UPDATE alert_rules SET enabled = true`.execute(db);
});

async function failedSession(org = 'ps_cubbonpark', error = 'ffprobe: moov atom not found'): Promise<string> {
  const r = await db
    .insertInto('upload_sessions')
    .values({
      created_by: uploader, org_unit_id: orgs[org]!.id, original_filename: 'BWC_fail.mp4', declared_size: 1000, chunk_size: 16 * 1024 * 1024, total_chunks: 1,
      staging_bucket: storage().bucket('staging'), staging_key: `test/${Date.now()}`, expires_at: new Date(Date.now() + 3600_000), status: 'FAILED', error,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

describe('raiseAlert (shared helper)', () => {
  it('dedupes open alerts, escalates severity, respects disabled rules and onlyIfNew', async () => {
    const a = await raiseAlert(db, { ruleCode: 'QUEUE_BACKLOG', title: 't', message: 'm1', dedupeKey: 'T:1' });
    expect(a).toMatchObject({ created: true, suppressed: false, severity: 'WARNING' }); // rule default severity
    const b = await raiseAlert(db, { ruleCode: 'QUEUE_BACKLOG', severity: 'CRITICAL', title: 't', message: 'm2', dedupeKey: 'T:1' });
    expect(b).toMatchObject({ id: a.id, created: false, severity: 'CRITICAL' });
    const c = await raiseAlert(db, { ruleCode: 'QUEUE_BACKLOG', severity: 'INFO', title: 't', message: 'm3', dedupeKey: 'T:1' });
    expect(c.severity).toBe('CRITICAL'); // never lowered
    const [row] = await alertsFor('T:1');
    expect(row).toMatchObject({ occurrences: 3, message: 'm3', status: 'OPEN' });
    expect((await raiseAlert(db, { ruleCode: 'QUEUE_BACKLOG', title: 't', message: 'x', dedupeKey: 'T:1', onlyIfNew: true })).created).toBe(false);
    expect((await alertsFor('T:1'))[0]!.occurrences).toBe(3);
    await setRule('QUEUE_BACKLOG', { enabled: false });
    expect(await raiseAlert(db, { ruleCode: 'QUEUE_BACKLOG', title: 't', message: 'x', dedupeKey: 'T:2' })).toMatchObject({ suppressed: true, id: null });
    expect(await alertsFor('T:2')).toHaveLength(0);
  });
});

describe('alert rules', () => {
  it('UPLOAD_FAILED: one alert per failed session, idempotent, skips sessions the ingest worker already alerted', async () => {
    const s1 = await failedSession();
    const s2 = await failedSession();
    await raiseAlert(db, { ruleCode: 'UPLOAD_FAILED', title: 'ingest', message: 'from ingest worker', resourceType: 'upload_session', resourceId: s2, dedupeKey: `UPLOAD_FAILED:${s2}` });
    const r1 = await evaluateRule(db, 'UPLOAD_FAILED');
    expect(r1.raised).toBeGreaterThanOrEqual(1); // other suites' failed uploads may also be in the window
    const [a] = await alertsFor(`UPLOAD_FAILED:${s1}`);
    expect(a).toMatchObject({ rule_code: 'UPLOAD_FAILED', severity: 'WARNING', org_unit_id: orgs.ps_cubbonpark!.id, resource_id: s1 });
    expect(a!.message).toContain('moov atom');
    expect((await alertsFor(`UPLOAD_FAILED:${s2}`))[0]!.occurrences).toBe(1);
    // re-run: nothing new; cursor advanced
    expect((await evaluateRule(db, 'UPLOAD_FAILED')).raised).toBe(0);
    expect((await alertsFor(`UPLOAD_FAILED:${s1}`))[0]!.occurrences).toBe(1);
    const cur = await db.selectFrom('alert_cursors').selectAll().where('rule_code', '=', 'UPLOAD_FAILED').executeTakeFirstOrThrow();
    expect(new Date(cur.watermark).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // resolved per-event alerts are not re-opened by a later overlapping scan
    await db.updateTable('alerts').set({ status: 'RESOLVED', resolved_at: new Date() }).where('dedupe_key', '=', `UPLOAD_FAILED:${s1}`).execute();
    await db.updateTable('alert_cursors').set({ watermark: new Date(Date.now() - 3600_000) }).where('rule_code', '=', 'UPLOAD_FAILED').execute();
    expect((await evaluateRule(db, 'UPLOAD_FAILED')).raised).toBe(0);
    expect(await alertsFor(`UPLOAD_FAILED:${s1}`)).toHaveLength(1);
  });

  it('UPLOAD_FAILED: quarantined evidence raises an alert', async () => {
    const q = await createRegisteredEvidence({ db, orgCode: 'ps_highgrounds', uploadedBy: uploader });
    await db.updateTable('evidence').set({ status: 'QUARANTINED', status_reason: 'container/extension mismatch' }).where('id', '=', q.id).execute();
    await evaluateRule(db, 'UPLOAD_FAILED');
    const [a] = await alertsFor(`UPLOAD_QUARANTINED:${q.id}`);
    expect(a).toMatchObject({ org_unit_id: orgs.ps_highgrounds!.id, resource_type: 'evidence' });
    expect(a!.message).toContain('extension mismatch');
    await db.updateTable('evidence').set({ status: 'REGISTERED', status_reason: null }).where('id', '=', q.id).execute();
  });

  it('respects disabled rules (cursor still advances) and configured severity', async () => {
    await setRule('UPLOAD_FAILED', { enabled: false });
    const s = await failedSession();
    const r = await evaluateRule(db, 'UPLOAD_FAILED');
    expect(r).toMatchObject({ enabled: false, raised: 0 });
    expect(await alertsFor(`UPLOAD_FAILED:${s}`)).toHaveLength(0);
    expect(await db.selectFrom('alert_cursors').select('rule_code').where('rule_code', '=', 'UPLOAD_FAILED').executeTakeFirst()).toBeTruthy();
    await setRule('UPLOAD_FAILED', { enabled: true, severity: 'CRITICAL' });
    await evaluateRule(db, 'UPLOAD_FAILED'); // still inside the overlap window → now raised with the configured severity
    expect((await alertsFor(`UPLOAD_FAILED:${s}`))[0]!.severity).toBe('CRITICAL');
    await setRule('UPLOAD_FAILED', { severity: 'WARNING' });
  });

  it('PROCESSING_FAILED raises and auto-resolves when the job later completes', async () => {
    const pj = await db.insertInto('processing_jobs').values({ kind: 'MEDIA_PROCESS', evidence_id: ev.id, status: 'FAILED', error: 'ffmpeg exited 1', finished_at: new Date(), attempts: 1 }).returning('id').executeTakeFirstOrThrow();
    await evaluateRule(db, 'PROCESSING_FAILED');
    const [a] = await alertsFor(`PROCESSING_FAILED:${pj.id}`);
    expect(a).toMatchObject({ status: 'OPEN', resource_id: ev.id, org_unit_id: ev.orgUnitId });
    await db.updateTable('processing_jobs').set({ status: 'COMPLETED' }).where('id', '=', pj.id).execute();
    const r = await evaluateRule(db, 'PROCESSING_FAILED');
    expect(r.resolved).toBe(1);
    const [b] = await alertsFor(`PROCESSING_FAILED:${pj.id}`);
    expect(b).toMatchObject({ status: 'RESOLVED', auto_resolved: true });
    expect(b!.resolution_note).toMatch(/Auto-resolved/);
  });

  it('AI_FAILURE and INTEGRITY_FAILURE (not double-reported when the fixity worker already alerted)', async () => {
    const job = await db.insertInto('ai_jobs').values({ evidence_id: ev.id, requested_by: meeraId, tasks: ['OBJECT_DETECTION'], status: 'FAILED', error: 'model artefact missing', input: JSON.stringify({}), finished_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('integrity_checks').values({ evidence_id: ev.id, trigger: 'SCHEDULED', expected_sha256: ev.sha256, actual_sha256: 'f'.repeat(64), ok: false }).execute();
    await evaluateRule(db, 'AI_FAILURE');
    expect((await alertsFor(`AI_FAILURE:${job.id}`))[0]).toMatchObject({ rule_code: 'AI_FAILURE', org_unit_id: ev.orgUnitId });
    await evaluateRule(db, 'INTEGRITY_FAILURE');
    const integ = await db.selectFrom('alerts').selectAll().where('rule_code', '=', 'INTEGRITY_FAILURE').where('resource_id', '=', ev.id).execute();
    expect(integ).toHaveLength(1);
    expect(integ[0]).toMatchObject({ severity: 'CRITICAL', resource_id: ev.id });
    // Another failed check while that alert is open → no second alert.
    await db.insertInto('integrity_checks').values({ evidence_id: ev.id, trigger: 'ON_DEMAND', expected_sha256: ev.sha256, actual_sha256: 'e'.repeat(64), ok: false }).execute();
    await evaluateRule(db, 'INTEGRITY_FAILURE');
    expect(await db.selectFrom('alerts').select('id').where('rule_code', '=', 'INTEGRITY_FAILURE').where('resource_id', '=', ev.id).execute()).toHaveLength(1);
  });

  it('STORAGE_THRESHOLD: warning → critical escalation (re-notify) → auto-resolve; unchanged snapshot does not bump', async () => {
    await db.insertInto('system_settings').values({ key: 'storagePolicy', value: JSON.stringify({ capacityBytes: 1000, warnThresholdPercent: 75, criticalThresholdPercent: 90 }) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify({ capacityBytes: 1000, warnThresholdPercent: 75, criticalThresholdPercent: 90 }) })).execute();
    await db.deleteFrom('storage_snapshots').execute();
    const snap = (bytes: number) => db.insertInto('storage_snapshots').values([{ bucket: 'b-evidence', tier: 'ACTIVE', object_count: 5, total_bytes: bytes }, { bucket: 'b-derived', tier: 'DERIVED', object_count: 1, total_bytes: 0 }]).execute();
    try {
      await snap(800);
      await evaluateRule(db, 'STORAGE_THRESHOLD');
      let [a] = await alertsFor('STORAGE_THRESHOLD:TOTAL');
      expect(a).toMatchObject({ severity: 'WARNING', status: 'OPEN', occurrences: 1, org_unit_id: null });
      await dispatchPendingAlerts(db);
      expect((await alertsFor('STORAGE_THRESHOLD:TOTAL'))[0]!.notified_at).not.toBeNull();
      await evaluateRule(db, 'STORAGE_THRESHOLD'); // same snapshot
      expect((await alertsFor('STORAGE_THRESHOLD:TOTAL'))[0]!.occurrences).toBe(1);
      await snap(950);
      await evaluateRule(db, 'STORAGE_THRESHOLD');
      [a] = await alertsFor('STORAGE_THRESHOLD:TOTAL');
      expect(a).toMatchObject({ severity: 'CRITICAL', occurrences: 2, notified_at: null });
      await snap(100);
      const r = await evaluateRule(db, 'STORAGE_THRESHOLD');
      expect(r.resolved).toBe(1);
      [a] = await alertsFor('STORAGE_THRESHOLD:TOTAL');
      expect(a).toMatchObject({ status: 'RESOLVED', auto_resolved: true });
    } finally {
      await db.deleteFrom('system_settings').where('key', '=', 'storagePolicy').execute();
      await db.deleteFrom('storage_snapshots').execute();
    }
  });

  it('QUEUE_BACKLOG raises for a backed-up queue and auto-resolves when drained', async () => {
    await setRule('QUEUE_BACKLOG', { config: { maxQueued: 2, maxAgeMinutes: 60 } });
    const boss = await getQueue();
    const q = 'lifecycle.dispose';
    for (let i = 0; i < 3; i++) await boss.send(q, { disposalRequestId: `00000000-0000-0000-0000-00000000000${i}` });
    try {
      await evaluateRule(db, 'QUEUE_BACKLOG');
      const [a] = await alertsFor(`QUEUE_BACKLOG:${q}`);
      expect(a).toMatchObject({ status: 'OPEN', resource_type: 'queue', resource_id: q });
      expect(a!.message).toMatch(/3 jobs waiting/);
    } finally {
      await sql`DELETE FROM pgboss.job WHERE name = ${q}`.execute(db);
    }
    await evaluateRule(db, 'QUEUE_BACKLOG');
    expect((await alertsFor(`QUEUE_BACKLOG:${q}`))[0]).toMatchObject({ status: 'RESOLVED', auto_resolved: true });
    await setRule('QUEUE_BACKLOG', { config: { maxQueued: 500, maxAgeMinutes: 60 } });
  });

  it('EXCESSIVE_DOWNLOADS: per actor per hour above threshold; bumps only on new activity', async () => {
    await setRule('EXCESSIVE_DOWNLOADS', { config: { perHour: 3 } });
    const actor = { type: 'USER' as const, id: meeraId, name: 'Meera Rao' };
    const dl = () => appendAudit(db, actor, { action: 'EVIDENCE_DOWNLOADED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.orgUnitId });
    for (let i = 0; i < 3; i++) await dl();
    await evaluateRule(db, 'EXCESSIVE_DOWNLOADS');
    expect(await alertsFor(`EXCESSIVE_DOWNLOADS:USER:${meeraId}`)).toHaveLength(0); // 3 is not > 3
    await dl();
    await evaluateRule(db, 'EXCESSIVE_DOWNLOADS');
    let [a] = await alertsFor(`EXCESSIVE_DOWNLOADS:USER:${meeraId}`);
    expect(a).toMatchObject({ occurrences: 1, org_unit_id: orgs.ps_cubbonpark!.id, resource_type: 'user' });
    await evaluateRule(db, 'EXCESSIVE_DOWNLOADS');
    expect((await alertsFor(`EXCESSIVE_DOWNLOADS:USER:${meeraId}`))[0]!.occurrences).toBe(1);
    await dl();
    await evaluateRule(db, 'EXCESSIVE_DOWNLOADS');
    [a] = await alertsFor(`EXCESSIVE_DOWNLOADS:USER:${meeraId}`);
    expect(a!.occurrences).toBe(2);
    expect(a!.message).toMatch(/^5 downloads/);
  });

  it('AUTH_BRUTE_FORCE by IP and by account; POLICY_VIOLATION on repeated denials', async () => {
    await setRule('AUTH_BRUTE_FORCE', { config: { failuresPer15Min: 5 } });
    await setRule('POLICY_VIOLATION', { config: { deniedPer15Min: 3 } });
    await db.insertInto('login_attempts').values(Array.from({ length: 6 }, (_, i) => ({ username: i % 2 ? 'io.arjun' : 'nosuchuser', ip: '203.0.113.77', success: false, reason: 'BAD_PASSWORD' }))).execute();
    await db.insertInto('login_attempts').values(Array.from({ length: 6 }, () => ({ username: 'io.arjun', ip: '198.51.100.1', success: false, reason: 'BAD_PASSWORD' }))).execute();
    await evaluateRule(db, 'AUTH_BRUTE_FORCE');
    expect((await alertsFor('AUTH_BRUTE_FORCE:ip:203.0.113.77'))[0]).toMatchObject({ severity: 'CRITICAL', org_unit_id: null });
    const [u] = await alertsFor('AUTH_BRUTE_FORCE:user:io.arjun');
    expect(u).toMatchObject({ org_unit_id: orgs.ps_indiranagar!.id, resource_type: 'user' });
    expect(u!.message).not.toMatch(/Passw0rd/);

    const actor = { type: 'USER' as const, id: meeraId, name: 'Meera Rao' };
    for (let i = 0; i < 4; i++) await appendAudit(db, actor, { action: i % 2 ? 'ACCESS_DENIED' : 'EVIDENCE_ACCESS_DENIED', outcome: 'DENIED', resourceType: 'route', resourceId: 'GET /x' });
    await evaluateRule(db, 'POLICY_VIOLATION');
    expect((await alertsFor(`POLICY_VIOLATION:${meeraId}`))[0]).toMatchObject({ severity: 'WARNING', org_unit_id: orgs.ps_cubbonpark!.id });
    await db.deleteFrom('login_attempts').execute();
    await setRule('AUTH_BRUTE_FORCE', { config: { failuresPer15Min: 20 } });
    await setRule('POLICY_VIOLATION', { config: { deniedPer15Min: 10 } });
  });

  it('AUDIT_CHAIN_BROKEN: incremental cursor; detects tampering (full pass) and holds the cursor before the bad record', async () => {
    const r1 = await evaluateRule(db, 'AUDIT_CHAIN_BROKEN');
    expect(r1.raised).toBe(0);
    const c1 = await db.selectFrom('alert_cursors').selectAll().where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').executeTakeFirstOrThrow();
    const head = await db.selectFrom('audit_events').select(sql<string>`max(seq)`.as('m')).executeTakeFirstOrThrow();
    expect(Number(c1.last_seq)).toBe(Number(head.m));
    expect(c1.state).toMatchObject({ lastMode: 'FULL' });
    await appendAudit(db, { type: 'SYSTEM', id: 'test' }, { action: 'AUDIT_VERIFIED', details: { n: 1 } });
    await evaluateRule(db, 'AUDIT_CHAIN_BROKEN');
    const c2 = await db.selectFrom('alert_cursors').selectAll().where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').executeTakeFirstOrThrow();
    expect(c2.state).toMatchObject({ lastMode: 'INCREMENTAL', lastChecked: 1 });

    // Tamper with an old record as the superuser (bypassing the append-only trigger), force a full pass.
    const victim = Math.max(2, Number(head.m) - 3);
    const { rows } = await owner.query<{ details: object }>('SELECT details FROM audit_events WHERE seq = $1', [victim]);
    await owner.query('SET session_replication_role = replica');
    await owner.query(`UPDATE audit_events SET details = details || '{"tampered":true}' WHERE seq = $1`, [victim]);
    try {
      await db.updateTable('alert_cursors').set({ state: JSON.stringify({ lastFullAt: '2000-01-01T00:00:00Z' }) }).where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').execute();
      const r = await evaluateRule(db, 'AUDIT_CHAIN_BROKEN');
      expect(r.raised).toBe(1);
      const [a] = await alertsFor('AUDIT_CHAIN_BROKEN');
      expect(a).toMatchObject({ severity: 'CRITICAL', resource_id: String(victim), org_unit_id: null });
      const c3 = await db.selectFrom('alert_cursors').selectAll().where('rule_code', '=', 'AUDIT_CHAIN_BROKEN').executeTakeFirstOrThrow();
      expect(Number(c3.last_seq)).toBe(victim - 1);
      // Incremental runs from the bad record keep re-detecting it (occurrences grow) until investigated.
      await evaluateRule(db, 'AUDIT_CHAIN_BROKEN');
      expect((await alertsFor('AUDIT_CHAIN_BROKEN'))[0]!.occurrences).toBe(2);
    } finally {
      await owner.query('UPDATE audit_events SET details = $2 WHERE seq = $1', [victim, JSON.stringify(rows[0]!.details)]);
      await owner.query('SET session_replication_role = origin');
    }
    const ok = await sql<{ first_bad_seq: string | null }>`SELECT first_bad_seq FROM audit_verify(1)`.execute(db);
    expect(ok.rows[0]!.first_bad_seq).toBeNull();
  });
});

describe('notification fan-out', () => {
  let server: Server;
  let received: Array<{ body: string; sig: string | undefined }> = [];
  let status = 200;
  let url = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, sig: req.headers['x-ksp-signature'] as string | undefined });
        res.statusCode = status;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('notifies alerts:manage holders in the alert scope only; INFO alerts are not fanned out', async () => {
    received = [];
    const local = await raiseAlert(db, { ruleCode: 'UPLOAD_FAILED', title: 'Cubbon upload failed', message: 'x', orgUnitId: orgs.ps_cubbonpark!.id, dedupeKey: 'N:1' });
    const mysuru = await raiseAlert(db, { ruleCode: 'UPLOAD_FAILED', title: 'Mysuru upload failed', message: 'x', orgUnitId: orgs.ps_nazarbad!.id, dedupeKey: 'N:2' });
    const system = await raiseAlert(db, { ruleCode: 'AUDIT_CHAIN_BROKEN', title: 'Ledger', message: 'x', dedupeKey: 'N:3' });
    const info = await raiseAlert(db, { ruleCode: 'UPLOAD_FAILED', severity: 'INFO', title: 'fyi', message: 'x', orgUnitId: orgs.ps_cubbonpark!.id, dedupeKey: 'N:4' });
    const secret = 'whsec-test';
    const n = await dispatchPendingAlerts(db, [webhookChannel({ ALERT_WEBHOOK_URL: url, ALERT_WEBHOOK_SECRET: secret })]);
    expect(n).toBe(4);
    const notes = await db.selectFrom('notifications').select(['user_id', 'link', 'kind']).execute();
    const to = (alertId: string | null) => notes.filter((x) => x.link === `/alerts/${alertId}`).map((x) => x.user_id).sort();
    expect(to(local.id)).toEqual([adminId, kavyaId].sort());
    expect(to(local.id)).not.toContain(meeraId); // alerts:read only
    expect(to(mysuru.id)).toEqual([adminId]);
    expect(to(system.id)).toEqual([adminId]);
    expect(to(info.id)).toEqual([]);
    expect(notes.find((x) => x.link === `/alerts/${system.id}`)!.kind).toBe('ALERT_CRITICAL');
    // webhook received the 3 WARNING/CRITICAL alerts with a valid HMAC signature
    expect(received).toHaveLength(3);
    for (const r of received) expect(r.sig).toBe(`sha256=${createHmac('sha256', secret).update(r.body).digest('hex')}`);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: 'ksp.alert' });
    const deliveries = await db.selectFrom('alert_deliveries').select(['alert_id', 'channel', 'status']).where('alert_id', '=', local.id!).execute();
    expect(deliveries.map((d) => `${d.channel}:${d.status}`).sort()).toEqual(['IN_APP:SENT', 'WEBHOOK:SENT']);
    // idempotent: second dispatch sends nothing
    expect(await dispatchPendingAlerts(db, [webhookChannel({ ALERT_WEBHOOK_URL: url })])).toBe(0);
    expect(received).toHaveLength(3);
  });

  it('records webhook failures without failing the cycle', async () => {
    status = 500;
    const a = await raiseAlert(db, { ruleCode: 'UPLOAD_FAILED', title: 'x', message: 'x', dedupeKey: 'N:5' });
    await dispatchPendingAlerts(db, [webhookChannel({ ALERT_WEBHOOK_URL: url })]);
    const d = await db.selectFrom('alert_deliveries').select(['channel', 'status', 'detail']).where('alert_id', '=', a.id!).where('channel', '=', 'WEBHOOK').executeTakeFirstOrThrow();
    expect(d).toMatchObject({ status: 'FAILED' });
    expect(d.detail).toMatch(/HTTP 500/);
    status = 200;
  });
});
