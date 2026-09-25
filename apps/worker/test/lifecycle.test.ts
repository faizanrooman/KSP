import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetObjectLegalHoldCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { createDb, getQueue, loadConfig, stopQueue, storage, type Database } from '@ksp/core';
import { createRegisteredEvidence } from '../../api/test/fixtures/evidence.js';
import { runDisposal, runFixityCheck, runIntegritySweep, runLifecycleScan, runTierMigration } from '../src/jobs/lifecycle/index.js';
import { listVersions, type LifecycleDeps } from '../src/jobs/lifecycle/common.js';

let db: Database;
let deps: LifecycleDeps;
let uploader: string;
let approver: string;
let requester: string;

beforeAll(async () => {
  const cfg = loadConfig();
  db = createDb(cfg.DATABASE_URL, 4).db;
  await getQueue();
  deps = { db, storage: storage() };
  const id = async (u: string) => (await db.selectFrom('users').select('id').where('username', '=', u).executeTakeFirstOrThrow()).id;
  uploader = await id('op.cubbon');
  approver = await id('sup.kavya');
  requester = await id('ec.latha');
}, 120_000);

afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

const evRow = (id: string) =>
  db.selectFrom('evidence').select(['storage_tier', 'storage_bucket', 'storage_key', 'storage_version_id', 'archived_at', 'last_verified_at', 'object_lock_until', 'status']).where('id', '=', id).executeTakeFirstOrThrow();

describe('tier migration', () => {
  it('copies with object lock, verifies hashes, switches the pointer, deletes the old version and stays verifiable', async () => {
    const st = storage();
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const res = await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ARCHIVE' });
    expect(res.status).toBe('MIGRATED');
    // versitygw honours governance bypass for this principal, so the superseded version is really removed.
    expect(res.oldCopy).toBe('DELETED');
    const row = await evRow(ev.id);
    expect(row).toMatchObject({ storage_tier: 'ARCHIVE', storage_bucket: st.bucket('archive'), storage_key: ev.key });
    expect(row.archived_at).toBeTruthy();
    expect(row.object_lock_until).toBeTruthy();
    // Ask the store itself: the new tier copy must carry a real Object Lock retention.
    const { GetObjectRetentionCommand } = await import('@aws-sdk/client-s3');
    const ret = await storage().s3.send(new GetObjectRetentionCommand({ Bucket: row.storage_bucket!, Key: row.storage_key!, VersionId: row.storage_version_id ?? undefined }));
    expect(ret.Retention?.Mode).toBe(storage().cfg.OBJECT_LOCK_MODE);
    expect(ret.Retention?.RetainUntilDate && ret.Retention.RetainUntilDate > new Date()).toBe(true);
    const head = await st.s3.send(new HeadObjectCommand({ Bucket: row.storage_bucket!, Key: row.storage_key!, VersionId: row.storage_version_id ?? undefined }));
    expect(head.ObjectLockMode).toBe('GOVERNANCE');
    expect(await listVersions(st, ev.bucket, ev.key)).toEqual([]);
    const copies = await db.selectFrom('evidence_storage_copies').select(['tier', 'status']).where('evidence_id', '=', ev.id).orderBy('id').execute();
    expect(copies).toEqual([{ tier: 'ACTIVE', status: 'DELETED' }, { tier: 'ARCHIVE', status: 'CURRENT' }]);
    const checks = await db.selectFrom('integrity_checks').select(['trigger', 'ok']).where('evidence_id', '=', ev.id).execute();
    expect(checks).toEqual([{ trigger: 'TIER_MIGRATION', ok: true }]);
    const audit = await db.selectFrom('audit_events').select('details').where('evidence_id', '=', ev.id).where('action', '=', 'EVIDENCE_TIER_CHANGED').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ from: 'ACTIVE', to: 'ARCHIVE', verifiedSha256: ev.sha256 });
    expect(JSON.stringify(audit.details)).not.toContain(ev.key);
    // Idempotent / no-op when already in the tier; fixity works against the new location.
    expect((await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ARCHIVE' })).status).toBe('NOOP');
    expect((await runFixityCheck(deps, { evidenceId: ev.id, trigger: 'SCHEDULED' })).status).toBe('OK');
    // Further to long-term, then back to active.
    expect((await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'LONG_TERM' })).status).toBe('MIGRATED');
    expect((await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ACTIVE' })).status).toBe('MIGRATED');
    const back = await evRow(ev.id);
    expect(back).toMatchObject({ storage_tier: 'ACTIVE', storage_bucket: st.bucket('evidence'), archived_at: null });
    expect((await runFixityCheck(deps, { evidenceId: ev.id, trigger: 'RESTORE' })).status).toBe('OK');
  });

  it('keeps the superseded copy (RETAINED) under legal hold and applies the storage hold to the new copy; disposal later removes all copies', async () => {
    const st = storage();
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    await db.updateTable('evidence').set({ legal_hold: true, legal_hold_reason: 'court order', legal_hold_by: approver, legal_hold_at: new Date() }).where('id', '=', ev.id).execute();
    const res = await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ARCHIVE' });
    expect(res).toMatchObject({ status: 'MIGRATED', oldCopy: 'RETAINED' });
    expect(res.oldCopyNote).toMatch(/legal hold/);
    const row = await evRow(ev.id);
    const lh = await st.s3.send(new GetObjectLegalHoldCommand({ Bucket: row.storage_bucket!, Key: row.storage_key!, VersionId: row.storage_version_id ?? undefined }));
    expect(lh.LegalHold?.Status).toBe('ON');
    expect((await listVersions(st, ev.bucket, ev.key)).length).toBe(1);
    const copies = await db.selectFrom('evidence_storage_copies').select(['tier', 'status']).where('evidence_id', '=', ev.id).orderBy('id').execute();
    expect(copies).toEqual([{ tier: 'ACTIVE', status: 'RETAINED' }, { tier: 'ARCHIVE', status: 'CURRENT' }]);

    // Release hold (DB + storage), then an approved disposal removes BOTH the current and the retained copy.
    await db.updateTable('evidence').set({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null }).where('id', '=', ev.id).execute();
    const { setObjectLegalHold } = await import('../src/jobs/lifecycle/common.js');
    expect(await setObjectLegalHold(st, row.storage_bucket!, row.storage_key!, row.storage_version_id, false)).toBe('APPLIED');
    const dr = await db.insertInto('disposal_requests').values({ evidence_id: ev.id, requested_by: requester, reason: 'retention expired long ago', authority_ref: 'GO-X', status: 'APPROVED', decided_by: approver, decided_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('evidence').set({ status: 'DISPOSAL_PENDING' }).where('id', '=', ev.id).execute();
    const out = await runDisposal(deps, { disposalRequestId: dr.id });
    expect(out).toMatchObject({ status: 'EXECUTED', versionsDeleted: 2 });
    expect(await listVersions(st, ev.bucket, ev.key)).toEqual([]);
    expect(await listVersions(st, st.bucket('archive'), ev.key)).toEqual([]);
    const after = await db.selectFrom('evidence_storage_copies').select('status').where('evidence_id', '=', ev.id).execute();
    expect(after.every((c) => c.status === 'DISPOSED' || c.status === 'DELETED')).toBe(true);
  });

  it('refuses to switch the pointer when the copy does not verify', async () => {
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader, corruptRecordedHash: true });
    const res = await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ARCHIVE' });
    expect(res.status).toBe('FAILED');
    const row = await evRow(ev.id);
    expect(row).toMatchObject({ storage_tier: 'ACTIVE', storage_bucket: ev.bucket, storage_key: ev.key });
    expect(await listVersions(storage(), storage().bucket('archive'), ev.key)).toEqual([]);
    const check = await db.selectFrom('integrity_checks').select(['trigger', 'ok']).where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect(check).toEqual({ trigger: 'TIER_MIGRATION', ok: false });
    const alert = await db.selectFrom('alerts').select(['severity', 'rule_code']).where('dedupe_key', '=', `TIER_VERIFY:${ev.id}`).executeTakeFirstOrThrow();
    expect(alert).toEqual({ severity: 'CRITICAL', rule_code: 'INTEGRITY_FAILURE' });
  });
});

describe('scheduled scans', () => {
  it('lifecycle.scan assigns default retention, queues due tier moves and never disposes', async () => {
    const old = new Date(Date.now() - 800 * 86_400_000); // default policy: archive 180d, long-term 730d, retain 2555d
    const unassigned = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader, retentionPolicyCode: null });
    const due = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader, registeredAt: old });
    const expired = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader, registeredAt: new Date(Date.now() - 400 * 86_400_000), retentionPolicyCode: 'non_evidentiary' });
    const res = await runLifecycleScan(deps);
    expect(res.retentionAssigned).toBeGreaterThanOrEqual(1);
    const u = await db.selectFrom('evidence as e').innerJoin('retention_policies as rp', 'rp.id', 'e.retention_policy_id').select(['rp.is_default', 'e.retain_until']).where('e.id', '=', unassigned.id).executeTakeFirstOrThrow();
    expect(u.is_default).toBe(true);
    expect(u.retain_until).toBeTruthy();
    expect(res.tierQueued).toEqual(expect.arrayContaining([{ evidenceId: due.id, targetTier: 'LONG_TERM' }, { evidenceId: expired.id, targetTier: 'ARCHIVE' }]));
    const pj = await db.selectFrom('processing_jobs').select(['status', 'queue_job_id']).where('evidence_id', '=', due.id).where('kind', '=', 'TIER_MIGRATE').executeTakeFirstOrThrow();
    expect(pj.status).toBe('QUEUED');
    const job = await sql<{ name: string; data: { targetTier: string } }>`SELECT name, data FROM pgboss.job WHERE id = ${pj.queue_job_id}::uuid`.execute(db).catch(() => null);
    if (job) expect(job.rows[0]).toMatchObject({ name: 'lifecycle.tier', data: { targetTier: 'LONG_TERM' } });
    expect(res.disposalCandidates).toBeGreaterThanOrEqual(1);
    expect((await evRow(expired.id)).status).toBe('REGISTERED');
    // Second scan does not re-queue work that is already queued.
    const again = await runLifecycleScan(deps);
    expect(again.tierQueued.map((t) => t.evidenceId)).not.toContain(due.id);
    // Executing the queued job moves it.
    expect((await runTierMigration(deps, { evidenceId: due.id, targetTier: 'LONG_TERM' }, pj.queue_job_id!)).status).toBe('MIGRATED');
    expect((await evRow(due.id)).storage_tier).toBe('LONG_TERM');
  });

  it('integrity.sweep queues the least-recently-verified originals first', async () => {
    const never = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const res = await runIntegritySweep(deps, { batch: 500 });
    expect(res.queued).toContain(never.id);
    const again = await runIntegritySweep(deps, { batch: 500 });
    expect(again.queued).not.toContain(never.id);
    const pj = await db.selectFrom('processing_jobs').select(['queue_job_id']).where('evidence_id', '=', never.id).where('kind', '=', 'FIXITY_CHECK').executeTakeFirstOrThrow();
    expect((await runFixityCheck(deps, { evidenceId: never.id, trigger: 'SCHEDULED' }, pj.queue_job_id!)).status).toBe('OK');
    expect((await evRow(never.id)).last_verified_at).toBeTruthy();
  });
});
