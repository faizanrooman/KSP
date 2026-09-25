/**
 * Storage tier migration of an ORIGINAL: copy to the target tier bucket (Object Lock applied), re-hash the new
 * copy and verify SHA-256/SHA-512/size BEFORE switching the evidence pointer, then try to delete the superseded
 * version with governance bypass. If the store refuses, the old copy is kept and recorded as RETAINED.
 */
import { wormCopy } from '@ksp/core';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { appendAudit } from '@ksp/core';
import type { TierMigratePayload } from '@ksp/shared';
import { ProcessingTracker } from '../../lib/processing.js';
import { ACTOR, STORED_STATUSES, ensureCurrentCopy, errText, hashWithProgress, noopLog, raiseAlert, setObjectLegalHold, type LifecycleDeps } from './common.js';


export interface TierResult {
  status: 'MIGRATED' | 'NOOP' | 'FAILED' | 'SKIPPED';
  reason?: string;
  oldCopy?: 'DELETED' | 'RETAINED';
  oldCopyNote?: string | null;
}

export async function runTierMigration(deps: LifecycleDeps, payload: TierMigratePayload, queueJobId?: string): Promise<TierResult> {
  const { db, storage } = deps;
  const log = deps.log ?? noopLog;
  const ev = await db
    .selectFrom('evidence')
    .select(['id', 'status', 'sha256', 'sha512', 'size_bytes', 'storage_bucket', 'storage_key', 'storage_version_id', 'storage_tier', 'object_lock_until', 'org_unit_id', 'legal_hold', 'evidence_number'])
    .where('id', '=', payload.evidenceId)
    .executeTakeFirst();
  if (!ev || !STORED_STATUSES.includes(ev.status) || !ev.storage_bucket || !ev.storage_key || !ev.sha256) return { status: 'SKIPPED', reason: ev ? `status ${ev.status}` : 'not found' };
  if (ev.storage_tier === payload.targetTier) return { status: 'NOOP' };
  const src = { bucket: ev.storage_bucket, key: ev.storage_key, versionId: ev.storage_version_id ?? undefined };
  const dstBucket = storage.bucketForTier(payload.targetTier);
  // WORM stores may keep a tombstone for a key whose versions were all deleted and refuse a conditional
  // write to it again (observed on versitygw). Never reuse a key: if this bucket already held a copy under the
  // base key, suffix it deterministically (stable across retries: the copy count only changes at switch time).
  const baseKey = ev.storage_key.split('@')[0]!;
  const prior = await db.selectFrom('evidence_storage_copies').select(['bucket', 'object_key']).where('evidence_id', '=', ev.id).execute();
  const reused = prior.some((c) => c.bucket === dstBucket && c.object_key.split('@')[0] === baseKey);
  const dst = { bucket: dstBucket, key: reused ? `${baseKey}@${prior.length}` : baseKey };
  if (dst.bucket === src.bucket) return { status: 'FAILED', reason: 'target tier maps to the same bucket; check S3_BUCKET_* configuration' };

  const tracker = await ProcessingTracker.start(db, { kind: 'TIER_MIGRATE', evidenceId: ev.id, queueJobId });
  try {
    // 1. Copy (idempotent: a copy left by an earlier attempt is re-verified rather than overwritten).
    let newVersion: string | undefined;
    const existing = await storage.head(dst.bucket, dst.key);
    if (existing) newVersion = existing.VersionId;
    // Server-side multipart copy: honours Object Lock + If-None-Match on stores that ignore them on CopyObject
    // (observed on versitygw) and has no 5 GiB CopyObject limit. Retention of the source copy is preserved.
    else newVersion = (await wormCopy(storage, { ...src, size: Number(ev.size_bytes) }, dst, { lockUntil: ev.object_lock_until ?? undefined })).versionId ?? undefined;
    await tracker.progress(0.3);

    // 2. Verify the new copy byte-for-byte via hashes.
    const actual = await hashWithProgress(await storage.getStream(dst.bucket, dst.key, undefined, newVersion), ev.size_bytes, (f) => tracker.progress(0.3 + f * 0.6));
    const bad = actual.sha256 !== ev.sha256 || (ev.sha512 && actual.sha512 !== ev.sha512) || actual.size !== ev.size_bytes;
    if (bad) {
      const reason = `copy verification failed (sha256 ${actual.sha256.slice(0, 12)}…, size ${actual.size})`;
      await db.transaction().execute(async (tx) => {
        await tx.insertInto('integrity_checks').values({ evidence_id: ev.id, trigger: 'TIER_MIGRATION', expected_sha256: ev.sha256!, actual_sha256: actual.sha256, ok: false, error: reason }).execute();
        await appendAudit(tx, ACTOR, { action: 'EVIDENCE_TIER_CHANGE_FAILED', outcome: 'FAILURE', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { from: ev.storage_tier, to: payload.targetTier, reason } });
        await raiseAlert(tx, { ruleCode: 'INTEGRITY_FAILURE', severity: 'CRITICAL', title: `Tier migration verification failed for ${ev.evidence_number ?? ev.id}`, message: reason, resourceType: 'evidence', resourceId: ev.id, orgUnitId: ev.org_unit_id, dedupeKey: `TIER_VERIFY:${ev.id}` });
      });
      await storage.delete(dst.bucket, dst.key, { versionId: newVersion, bypassGovernance: true }).catch(() => undefined);
      await tracker.fail(new Error(reason));
      return { status: 'FAILED', reason };
    }
    const head = await storage.s3.send(new HeadObjectCommand({ Bucket: dst.bucket, Key: dst.key, VersionId: newVersion }));
    const lockUntil = head.ObjectLockRetainUntilDate ?? null;

    // 3. Switch the pointer (same tx: copy registry, integrity record, custody event).
    const switched = await db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('evidence').select(['status', 'storage_bucket', 'storage_key', 'storage_version_id', 'storage_tier', 'legal_hold']).where('id', '=', ev.id).forUpdate().executeTakeFirstOrThrow();
      if (!STORED_STATUSES.includes(cur.status) || cur.storage_bucket !== src.bucket || cur.storage_key !== src.key || (cur.storage_version_id ?? undefined) !== src.versionId) return null;
      await ensureCurrentCopy(tx, { id: ev.id, storage_tier: ev.storage_tier, storage_bucket: src.bucket, storage_key: src.key, storage_version_id: ev.storage_version_id, sha256: ev.sha256!, object_lock_until: ev.object_lock_until });
      await tx.updateTable('evidence_storage_copies').set({ status: 'RETAINED', status_note: `superseded by migration to ${payload.targetTier}` }).where('evidence_id', '=', ev.id).where('status', '=', 'CURRENT').execute();
      await tx
        .insertInto('evidence_storage_copies')
        .values({ evidence_id: ev.id, tier: payload.targetTier, bucket: dst.bucket, object_key: dst.key, version_id: newVersion ?? null, sha256: actual.sha256, status: 'CURRENT', object_lock_until: lockUntil })
        .onConflict((oc) => oc.columns(['bucket', 'object_key', 'version_id']).doUpdateSet({ status: 'CURRENT', status_note: null }))
        .execute();
      await tx
        .updateTable('evidence')
        .set({
          storage_bucket: dst.bucket,
          storage_key: dst.key,
          storage_version_id: newVersion ?? null,
          storage_tier: payload.targetTier,
          object_lock_until: lockUntil,
          archived_at: payload.targetTier === 'ACTIVE' ? null : new Date(),
          last_verified_at: new Date(),
        })
        .where('id', '=', ev.id)
        .execute();
      await tx.insertInto('integrity_checks').values({ evidence_id: ev.id, trigger: 'TIER_MIGRATION', expected_sha256: ev.sha256!, actual_sha256: actual.sha256, ok: true }).execute();
      await appendAudit(tx, ACTOR, {
        action: 'EVIDENCE_TIER_CHANGED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
        details: { from: ev.storage_tier, to: payload.targetTier, verifiedSha256: actual.sha256, sha512Verified: !!ev.sha512, bytes: actual.size, objectLockUntil: lockUntil },
      });
      return { legalHold: cur.legal_hold };
    });
    if (!switched) {
      await tracker.complete({ skipped: 'evidence changed during migration' });
      return { status: 'SKIPPED', reason: 'evidence changed during migration' };
    }

    // 4. Defence in depth: the new copy inherits the legal hold.
    if (switched.legalHold) await setObjectLegalHold(storage, dst.bucket, dst.key, newVersion, true);

    // 5. Remove the superseded version (governance bypass). Keep it (and say so) if the store refuses or a hold applies.
    let oldCopy: 'DELETED' | 'RETAINED' = 'RETAINED';
    let note: string | null = null;
    if (switched.legalHold) note = 'retained: evidence under legal hold';
    else {
      try {
        await storage.delete(src.bucket, src.key, { versionId: src.versionId, bypassGovernance: true });
        oldCopy = 'DELETED';
        note = 'deleted with governance bypass after verified migration';
      } catch (err) {
        note = `retained: store refused delete (${errText(err)})`;
        log.warn({ evidenceId: ev.id, err: errText(err) }, 'superseded original retained');
      }
    }
    let q = db.updateTable('evidence_storage_copies').set({ status: oldCopy, status_note: note }).where('evidence_id', '=', ev.id).where('bucket', '=', src.bucket).where('object_key', '=', src.key).where('status', '=', 'RETAINED');
    q = src.versionId ? q.where('version_id', '=', src.versionId) : q.where('version_id', 'is', null);
    await q.execute();
    await tracker.complete({ from: ev.storage_tier, to: payload.targetTier, oldCopy, note });
    return { status: 'MIGRATED', oldCopy, oldCopyNote: note };
  } catch (err) {
    await tracker.fail(err);
    throw err;
  }
}
