/** FN-6: fixity coverage target, candidate priorities, byte budget, RETAINED and DR copy verification. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { DEFAULT_SETTINGS } from '@ksp/shared';
import {
  createDb, drStoreFromEnv, getQueue, integrityCoverage, loadConfig, nightlyBatchSize, repoRoot, selectFixityCandidates, stopQueue, storage, type Database, type DrStore,
} from '@ksp/core';
import { createRegisteredEvidence } from '../../api/test/fixtures/evidence.js';
import { runFixityCheck, runIntegritySweep, runTierMigration } from '../src/jobs/lifecycle/index.js';
import type { LifecycleDeps } from '../src/jobs/lifecycle/common.js';

const run = promisify(execFile);
const cfg = loadConfig();
let db: Database;
let deps: LifecycleDeps;
let uploader: string;
let approver: string;
let dr: DrStore;
const DR_PREFIX = `fx${Date.now().toString(36)}-`;
const drEnv = { DR_S3_ENDPOINT: cfg.S3_ENDPOINT!, DR_S3_ACCESS_KEY: cfg.S3_ACCESS_KEY, DR_S3_SECRET_KEY: cfg.S3_SECRET_KEY };
const setPolicy = (p: Partial<typeof DEFAULT_SETTINGS.integrityPolicy>) => {
  const value = JSON.stringify({ ...DEFAULT_SETTINGS.integrityPolicy, ...p });
  return db.insertInto('system_settings').values({ key: 'integrityPolicy', value }).onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute();
};

beforeAll(async () => {
  db = createDb(cfg.DATABASE_URL, 4).db;
  await getQueue();
  deps = { db, storage: storage() };
  dr = drStoreFromEnv(drEnv)!;
  uploader = (await db.selectFrom('users').select('id').where('username', '=', 'op.cubbon').executeTakeFirstOrThrow()).id;
  approver = (await db.selectFrom('users').select('id').where('username', '=', 'sup.kavya').executeTakeFirstOrThrow()).id;
}, 120_000);
afterAll(async () => {
  await db.deleteFrom('system_settings').where('key', '=', 'integrityPolicy').execute();
  await stopQueue();
  await db.destroy();
});

describe('coverage target', () => {
  it('nightly batch = ceil(total / fullCycleDays) clamped to min/max', () => {
    const p = { ...DEFAULT_SETTINGS.integrityPolicy, fullCycleDays: 90, minPerNight: 100, maxPerNight: 200_000 };
    expect(nightlyBatchSize(36_000_000, p)).toBe(200_000);
    expect(nightlyBatchSize(3_600_000, p)).toBe(40_000);
    expect(nightlyBatchSize(36_001, p)).toBe(401);
    expect(nightlyBatchSize(500, p)).toBe(100);
    expect(nightlyBatchSize(0, p)).toBe(0);
  });

  it('priorities: never verified → recently tier-migrated → oldest verified; recently verified skipped; byte budget', async () => {
    const never = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const old = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const fresh = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const moved = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    await sql`UPDATE evidence SET last_verified_at = NULL WHERE id = ${never.id}::uuid`.execute(db);
    await sql`UPDATE evidence SET last_verified_at = now() - interval '60 days' WHERE id = ${old.id}::uuid`.execute(db);
    await sql`UPDATE evidence SET last_verified_at = now() - interval '1 hour' WHERE id = ${fresh.id}::uuid`.execute(db);
    expect((await runTierMigration(deps, { evidenceId: moved.id, targetTier: 'ARCHIVE' })).status).toBe('MIGRATED'); // verified while copying, just now
    const c = await selectFixityCandidates(db, { batch: 10_000, maxBytes: 0 });
    const pos = (id: string) => c.findIndex((x) => x.kind === 'PRIMARY' && x.evidenceId === id);
    expect(pos(never.id)).toBeGreaterThanOrEqual(0);
    expect(c[pos(never.id)]!.priority).toBe(0);
    expect(c[pos(moved.id)]!.priority).toBe(1);
    expect(c[pos(old.id)]!.priority).toBe(2);
    expect(pos(never.id)).toBeLessThan(pos(moved.id));
    expect(pos(moved.id)).toBeLessThan(pos(old.id));
    expect(pos(fresh.id)).toBe(-1);
    // byte budget: only what fits (always at least one)
    const one = await selectFixityCandidates(db, { batch: 10_000, maxBytes: 1 });
    expect(one).toHaveLength(1);
    const two = await selectFixityCandidates(db, { batch: 10_000, maxBytes: never.sizeBytes * 2 + 1 });
    expect(two.reduce((s, x) => s + x.sizeBytes, 0)).toBeLessThanOrEqual(never.sizeBytes * 2 + 1);
  });

  it('the sweep sizes its batch from the policy and reports coverage / projected cycle', async () => {
    await setPolicy({ fullCycleDays: 1, minPerNight: 1, maxPerNight: 100_000, maxBytesPerNight: 0 });
    const cov = await integrityCoverage(db);
    expect(cov.total).toBeGreaterThan(0);
    expect(cov.nightlyBatch).toBe(cov.total);
    expect(cov.projectedCycleDays).toBe(1);
    const res = await runIntegritySweep(deps);
    expect(res.batch).toBe(cov.total);
    expect(res.queued.length + res.queuedCopies.length).toBeGreaterThan(0);
    await setPolicy({ fullCycleDays: 90, minPerNight: 1, maxPerNight: 1 });
    const slow = await integrityCoverage(db);
    expect(slow.nightlyBatch).toBe(1);
    expect(slow.projectedCycleDays).toBe(slow.total);
    await db.deleteFrom('system_settings').where('key', '=', 'integrityPolicy').execute();
  });
});

describe('secondary copies', () => {
  it('verifies a RETAINED copy (own integrity_checks row, copy last_verified_at) and queues it from the sweep', async () => {
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    await db.updateTable('evidence').set({ legal_hold: true, legal_hold_reason: 'court order', legal_hold_by: approver, legal_hold_at: new Date() }).where('id', '=', ev.id).execute();
    expect(await runTierMigration(deps, { evidenceId: ev.id, targetTier: 'ARCHIVE' })).toMatchObject({ status: 'MIGRATED', oldCopy: 'RETAINED' });
    const copy = await db.selectFrom('evidence_storage_copies').selectAll().where('evidence_id', '=', ev.id).where('status', '=', 'RETAINED').executeTakeFirstOrThrow();
    const cand = await selectFixityCandidates(db, { batch: 10_000, maxBytes: 0 });
    expect(cand.find((c) => c.kind === 'RETAINED' && c.refId === Number(copy.id))).toMatchObject({ priority: 0 });
    const r = await runFixityCheck(deps, { evidenceId: ev.id, trigger: 'SCHEDULED', copy: { kind: 'RETAINED', id: Number(copy.id) } });
    expect(r.status).toBe('OK');
    const chk = await db.selectFrom('integrity_checks').selectAll().where('evidence_id', '=', ev.id).where('copy_kind', '=', 'RETAINED').executeTakeFirstOrThrow();
    expect(chk).toMatchObject({ ok: true, storage_copy_id: copy.id, actual_sha256: ev.sha256 });
    expect((await db.selectFrom('evidence_storage_copies').select('last_verified_at').where('id', '=', copy.id).executeTakeFirstOrThrow()).last_verified_at).toBeInstanceOf(Date);
    const audit = await db.selectFrom('audit_events').select('details').where('evidence_id', '=', ev.id).where('action', '=', 'EVIDENCE_INTEGRITY_VERIFIED').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ copy: 'RETAINED', storageCopyId: Number(copy.id) });
  });

  it('verifies a recorded DR copy through the DR store; a wrong/missing DR copy fails with its own alert', async () => {
    const ev = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const other = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: uploader });
    const env = { ...process.env, ...drEnv, DR_BUCKET_PREFIX: DR_PREFIX, DATABASE_URL: cfg.DATABASE_URL, S3_ENDPOINT: cfg.S3_ENDPOINT, S3_ACCESS_KEY: cfg.S3_ACCESS_KEY, S3_SECRET_KEY: cfg.S3_SECRET_KEY, S3_BUCKET_EVIDENCE: cfg.S3_BUCKET_EVIDENCE };
    for (const e of [ev, other]) {
      await run(process.execPath, [resolve(repoRoot(), 'scripts/backup/s3-replicate.ts'), '--buckets', 'evidence', '--prefix', e.key.slice(0, e.key.lastIndexOf('/') + 1), '--lock-days', '1'], { env });
    }
    const c = await db.selectFrom('dr_object_copies').selectAll().where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect((await selectFixityCandidates(db, { batch: 10_000, maxBytes: 0 })).find((x) => x.kind === 'DR' && x.refId === Number(c.id))).toBeTruthy();
    const ddeps = { ...deps, drStore: dr };
    expect(await runFixityCheck({ ...deps, drStore: null }, { evidenceId: ev.id, trigger: 'SCHEDULED', copy: { kind: 'DR', id: Number(c.id) } })).toMatchObject({ status: 'SKIPPED' });
    expect((await runFixityCheck(ddeps, { evidenceId: ev.id, trigger: 'SCHEDULED', copy: { kind: 'DR', id: Number(c.id) } })).status).toBe('OK');
    const ok = await db.selectFrom('integrity_checks').selectAll().where('evidence_id', '=', ev.id).where('copy_kind', '=', 'DR').executeTakeFirstOrThrow();
    expect(ok).toMatchObject({ ok: true, dr_copy_id: c.id });
    expect((await db.selectFrom('dr_object_copies').select('last_verified_at').where('id', '=', c.id).executeTakeFirstOrThrow()).last_verified_at).toBeInstanceOf(Date);
    // A registry row whose DR object holds different bytes (the other item's original) → FAILED + CRITICAL alert
    const o = await db.selectFrom('dr_object_copies').selectAll().where('evidence_id', '=', other.id).executeTakeFirstOrThrow();
    const bad = await db.insertInto('dr_object_copies').values({ evidence_id: ev.id, kind: 'ORIGINAL', bucket: o.bucket, object_key: o.object_key, version_id: null, sha256: ev.sha256 }).returning('id').executeTakeFirstOrThrow();
    const wrong = await runFixityCheck(ddeps, { evidenceId: ev.id, trigger: 'SCHEDULED', copy: { kind: 'DR', id: Number(bad.id) } });
    expect(wrong.status).toBe('FAILED');
    const alert = await db.selectFrom('alerts').selectAll().where('dedupe_key', '=', `INTEGRITY_FAILURE:${ev.id}:DR:${bad.id}`).executeTakeFirstOrThrow();
    expect(alert).toMatchObject({ severity: 'CRITICAL', rule_code: 'INTEGRITY_FAILURE' });
    expect(alert.title).toMatch(/DR copy/);
    // primary evidence verification state is untouched by copy checks
    const primaryChecks = await db.selectFrom('integrity_checks').select('copy_kind').where('evidence_id', '=', ev.id).execute();
    expect(primaryChecks.filter((x) => x.copy_kind === 'DR')).toHaveLength(2);
  });
});
