/**
 * OPS-5: DR copies recorded by scripts/backup/s3-replicate.ts are deleted by dr.dispose-sweep once the evidence is
 * DISPOSED. Drill pattern with two stores on the local gateway: the primary test buckets and a separate DR bucket set
 * (DR_BUCKET_PREFIX), replicated by the real script run as a child process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { HeadObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { createDb, drStoreFromEnv, getQueue, loadConfig, repoRoot, stopQueue, storage, type Database, type DrStore } from '@ksp/core';
import { createRegisteredEvidence } from '../../api/test/fixtures/evidence.js';
import { runDisposal } from '../src/jobs/lifecycle/index.js';
import { runDrDisposeSweep } from '../src/jobs/dr/index.js';

const run = promisify(execFile);
let db: Database;
let dr: DrStore;
let requester: string;
let approver: string;
let uploader: string;
const cfg = loadConfig();
const DR_PREFIX = `dr${Date.now().toString(36)}-`;
const drEnv = { DR_S3_ENDPOINT: cfg.S3_ENDPOINT!, DR_S3_ACCESS_KEY: cfg.S3_ACCESS_KEY, DR_S3_SECRET_KEY: cfg.S3_SECRET_KEY, DR_S3_FORCE_PATH_STYLE: 'true' };

async function replicate(prefix: string) {
  const env = {
    ...process.env, ...drEnv, DR_BUCKET_PREFIX: DR_PREFIX, DATABASE_URL: cfg.DATABASE_URL,
    S3_ENDPOINT: cfg.S3_ENDPOINT, S3_ACCESS_KEY: cfg.S3_ACCESS_KEY, S3_SECRET_KEY: cfg.S3_SECRET_KEY, S3_BUCKET_EVIDENCE: cfg.S3_BUCKET_EVIDENCE,
  };
  const { stdout } = await run(process.execPath, [resolve(repoRoot(), 'scripts/backup/s3-replicate.ts'), '--buckets', 'evidence', '--prefix', prefix, '--lock-days', '1'], { env, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout) as { copied: number; skipped: number; failed: number; problems: string[] };
}
const versions = async (bucket: string, key: string) => ((await dr.client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }))).Versions ?? []).filter((v) => v.Key === key);

beforeAll(async () => {
  db = createDb(cfg.DATABASE_URL, 4).db;
  await getQueue();
  dr = drStoreFromEnv(drEnv)!;
  const id = async (u: string) => (await db.selectFrom('users').select('id').where('username', '=', u).executeTakeFirstOrThrow()).id;
  [requester, approver, uploader] = await Promise.all([id('ec.latha'), id('sup.kavya'), id('op.cubbon')]);
}, 120_000);
afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

describe('DR disposal sweep (OPS-5)', () => {
  it('replication records DR copies; disposal + sweep deletes them (governance bypass), audited; idempotent', async () => {
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const keyPrefix = ev.key.slice(0, ev.key.lastIndexOf('/') + 1);
    const r1 = await replicate(keyPrefix);
    expect(r1).toMatchObject({ copied: 1, failed: 0 });
    const drBucket = DR_PREFIX + cfg.S3_BUCKET_EVIDENCE;
    const rows = await db.selectFrom('dr_object_copies').selectAll().where('evidence_id', '=', ev.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ORIGINAL', bucket: drBucket, object_key: ev.key, sha256: ev.sha256, status: 'PRESENT' });
    expect(rows[0]!.version_id).toBeTruthy();
    const h = await dr.client.send(new HeadObjectCommand({ Bucket: drBucket, Key: ev.key }));
    expect(h.ObjectLockMode).toBe('GOVERNANCE'); // WORM in the DR store too
    // re-running replication skips the copy and does not duplicate the record
    expect(await replicate(keyPrefix)).toMatchObject({ copied: 0, skipped: 1 });
    expect(await db.selectFrom('dr_object_copies').select('id').where('evidence_id', '=', ev.id).execute()).toHaveLength(1);

    // not disposed → the sweep leaves it alone
    expect((await runDrDisposeSweep(db, { store: dr })).candidates).toBe(0);
    expect(await versions(drBucket, ev.key)).toHaveLength(1);

    // authorised disposal on the primary (the real flow), then the DR sweep
    const req = await db.insertInto('disposal_requests').values({ evidence_id: ev.id, requested_by: requester, reason: 'retention expired long ago', authority_ref: 'GO-DR', status: 'APPROVED', decided_by: approver, decided_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('evidence').set({ status: 'DISPOSAL_PENDING' }).where('id', '=', ev.id).execute();
    expect(await runDisposal({ db, storage: storage() }, { disposalRequestId: req.id })).toMatchObject({ status: 'EXECUTED' });
    expect(await versions(drBucket, ev.key)).toHaveLength(1); // disposal alone does not reach the DR store
    const res = await runDrDisposeSweep(db, { store: dr });
    expect(res).toMatchObject({ configured: true, candidates: 1, deleted: 1, failed: 0 });
    expect(await versions(drBucket, ev.key)).toHaveLength(0);
    const after = await db.selectFrom('dr_object_copies').selectAll().where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect(after).toMatchObject({ status: 'DELETED', attempts: 1, last_error: null });
    expect(after.deleted_at).toBeInstanceOf(Date);
    const audit = await db.selectFrom('audit_events').select(['action', 'outcome', 'details', 'evidence_id']).where('evidence_id', '=', ev.id).where('action', 'like', 'EVIDENCE_DR_COPY%').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'EVIDENCE_DR_COPY_DELETED', outcome: 'SUCCESS', details: { bucket: drBucket, key: ev.key, kind: 'ORIGINAL', versionsDeleted: 1, bypassGovernance: true } });
    // idempotent
    expect((await runDrDisposeSweep(db, { store: dr })).candidates).toBe(0);
  });

  it('a refused deletion (no governance bypass) is recorded DELETE_FAILED, audited, and retried by the next sweep', async () => {
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const keyPrefix = ev.key.slice(0, ev.key.lastIndexOf('/') + 1);
    expect((await replicate(keyPrefix)).copied).toBe(1);
    const drBucket = DR_PREFIX + cfg.S3_BUCKET_EVIDENCE;
    const req = await db.insertInto('disposal_requests').values({ evidence_id: ev.id, requested_by: requester, reason: 'retention expired long ago', authority_ref: 'GO-DR2', status: 'APPROVED', decided_by: approver, decided_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('evidence').set({ status: 'DISPOSAL_PENDING' }).where('id', '=', ev.id).execute();
    await runDisposal({ db, storage: storage() }, { disposalRequestId: req.id });
    const noBypass = drStoreFromEnv({ ...drEnv, DR_S3_BYPASS_GOVERNANCE: 'false' })!;
    const res = await runDrDisposeSweep(db, { store: noBypass });
    expect(res).toMatchObject({ candidates: 1, deleted: 0, failed: 1 });
    expect(await versions(drBucket, ev.key)).toHaveLength(1);
    const row = await db.selectFrom('dr_object_copies').selectAll().where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'DELETE_FAILED', attempts: 1 });
    expect(row.last_error).toBeTruthy();
    const failed = await db.selectFrom('audit_events').select(['outcome']).where('evidence_id', '=', ev.id).where('action', '=', 'EVIDENCE_DR_COPY_DELETE_FAILED').execute();
    expect(failed).toEqual([{ outcome: 'FAILURE' }]);
    // next sweep with the proper identity/policy succeeds
    expect(await runDrDisposeSweep(db, { store: dr })).toMatchObject({ deleted: 1, failed: 0 });
    expect(await versions(drBucket, ev.key)).toHaveLength(0);
    expect((await db.selectFrom('dr_object_copies').select(['status', 'attempts']).where('evidence_id', '=', ev.id).executeTakeFirstOrThrow())).toEqual({ status: 'DELETED', attempts: 2 });
  });

  it('is a no-op when the DR store is not configured', async () => {
    expect(await runDrDisposeSweep(db, { store: null })).toMatchObject({ configured: false, candidates: 0 });
  });
});
