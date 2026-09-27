/**
 * Fixity check: stream the stored original (current tier bucket/key/version), recompute SHA-256 and SHA-512,
 * compare with the registered values, record integrity_checks, update last_verified_at, write a custody event,
 * and raise a CRITICAL INTEGRITY_FAILURE alert on mismatch or missing object.
 * With `payload.copy` the same is done for a secondary copy (FN-6): a RETAINED copy (evidence_storage_copies) in the
 * primary store or a DR copy (dr_object_copies) read through the DR store (DR_S3_*); the copy's last_verified_at is
 * updated instead of the evidence's. An unconfigured DR store skips the check (nothing recorded).
 */
import type { Readable } from 'node:stream';
import { appendAudit, drStoreFromEnv, type DrStore } from '@ksp/core';
import type { FixityCheckPayload } from '@ksp/shared';
import { ProcessingTracker } from '../../lib/processing.js';
import { ACTOR, STORED_STATUSES, errText, hashWithProgress, isMissingObject, noopLog, raiseAlert, type LifecycleDeps } from './common.js';

export interface FixityResult {
  status: 'OK' | 'FAILED' | 'SKIPPED';
  reason?: string;
  actualSha256?: string | null;
}

export async function runFixityCheck(deps: LifecycleDeps & { drStore?: DrStore | null }, payload: FixityCheckPayload, queueJobId?: string): Promise<FixityResult> {
  const { db, storage } = deps;
  const log = deps.log ?? noopLog;
  const ev = await db
    .selectFrom('evidence')
    .select(['id', 'status', 'sha256', 'sha512', 'size_bytes', 'storage_bucket', 'storage_key', 'storage_version_id', 'storage_tier', 'org_unit_id', 'evidence_number'])
    .where('id', '=', payload.evidenceId)
    .executeTakeFirst();
  if (!ev || !STORED_STATUSES.includes(ev.status) || !ev.storage_bucket || !ev.storage_key || !ev.sha256) {
    return { status: 'SKIPPED', reason: ev ? `not verifiable in status ${ev.status}` : 'evidence not found' };
  }
  // Which copy: the current one, or a recorded secondary copy.
  let open: () => Promise<Readable> = () => storage.getStream(ev.storage_bucket!, ev.storage_key!, undefined, ev.storage_version_id ?? undefined);
  let where: Record<string, unknown> = { copy: 'PRIMARY', tier: ev.storage_tier };
  const copy = payload.copy;
  if (copy?.kind === 'RETAINED') {
    const c = await db.selectFrom('evidence_storage_copies').selectAll().where('id', '=', copy.id).where('evidence_id', '=', ev.id).executeTakeFirst();
    if (!c || c.status !== 'RETAINED') return { status: 'SKIPPED', reason: 'retained copy no longer present' };
    open = () => storage.getStream(c.bucket, c.object_key, undefined, c.version_id ?? undefined);
    where = { copy: 'RETAINED', storageCopyId: c.id, tier: c.tier, bucket: c.bucket };
  } else if (copy?.kind === 'DR') {
    const store = deps.drStore === undefined ? drStoreFromEnv() : deps.drStore;
    if (!store) return { status: 'SKIPPED', reason: 'DR store not configured (DR_S3_*)' };
    const c = await db.selectFrom('dr_object_copies').selectAll().where('id', '=', copy.id).where('evidence_id', '=', ev.id).executeTakeFirst();
    if (!c || c.status !== 'PRESENT') return { status: 'SKIPPED', reason: 'DR copy no longer present' };
    open = () => store.getStream(c.bucket, c.object_key, c.version_id);
    where = { copy: 'DR', drCopyId: c.id, store: store.endpoint, bucket: c.bucket };
  }
  const tracker = await ProcessingTracker.start(db, { kind: copy ? 'FIXITY_CHECK_COPY' : 'FIXITY_CHECK', evidenceId: ev.id, queueJobId });
  let actual: { sha256: string; sha512: string; size: number } | null = null;
  let error: string | null = null;
  try {
    const stream = await open();
    actual = await hashWithProgress(stream, ev.size_bytes, (f) => tracker.progress(f));
  } catch (err) {
    if (!isMissingObject(err)) {
      // Transient storage problem: let pg-boss retry; nothing is recorded as verified or failed.
      await tracker.fail(err);
      throw err;
    }
    error = `${copy ? `${copy.kind} copy` : 'stored original'} not found (${errText(err)})`;
  }
  const mismatches: string[] = [];
  if (actual) {
    if (actual.sha256 !== ev.sha256) mismatches.push('sha256');
    if (ev.sha512 && actual.sha512 !== ev.sha512) mismatches.push('sha512');
    if (actual.size !== ev.size_bytes) mismatches.push(`size (${actual.size} != ${ev.size_bytes})`);
    if (mismatches.length) error = `hash mismatch: ${mismatches.join(', ')}`;
  }
  const ok = !!actual && !mismatches.length;
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('integrity_checks')
      .values({
        evidence_id: ev.id, trigger: payload.trigger, expected_sha256: ev.sha256!, actual_sha256: actual?.sha256 ?? null, ok, error, requested_by: payload.requestedBy ?? null,
        copy_kind: copy?.kind ?? 'PRIMARY', storage_copy_id: copy?.kind === 'RETAINED' ? copy.id : null, dr_copy_id: copy?.kind === 'DR' ? copy.id : null,
      })
      .execute();
    if (ok && !copy) await tx.updateTable('evidence').set({ last_verified_at: new Date() }).where('id', '=', ev.id).execute();
    if (ok && copy?.kind === 'RETAINED') await tx.updateTable('evidence_storage_copies').set({ last_verified_at: new Date() }).where('id', '=', copy.id).execute();
    if (ok && copy?.kind === 'DR') await tx.updateTable('dr_object_copies').set({ last_verified_at: new Date() }).where('id', '=', copy.id).execute();
    await appendAudit(tx, ACTOR, {
      action: ok ? 'EVIDENCE_INTEGRITY_VERIFIED' : 'EVIDENCE_INTEGRITY_FAILED',
      outcome: ok ? 'SUCCESS' : 'FAILURE',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: { trigger: payload.trigger, requestedBy: payload.requestedBy ?? null, tier: ev.storage_tier, ...where, expectedSha256: ev.sha256, actualSha256: actual?.sha256 ?? null, sha512Checked: !!ev.sha512, bytes: actual?.size ?? null, error },
    });
    if (!ok) {
      await raiseAlert(tx, {
        ruleCode: 'INTEGRITY_FAILURE',
        severity: 'CRITICAL',
        title: `Integrity check failed for ${ev.evidence_number ?? ev.id}${copy ? ` (${copy.kind} copy)` : ''}`,
        message: error ?? 'integrity failure',
        resourceType: 'evidence',
        resourceId: ev.id,
        orgUnitId: ev.org_unit_id,
        dedupeKey: copy ? `INTEGRITY_FAILURE:${ev.id}:${copy.kind}:${copy.id}` : `INTEGRITY_FAILURE:${ev.id}`,
      });
    }
  });
  if (ok) await tracker.complete({ ok: true, trigger: payload.trigger, sha256: actual!.sha256 });
  else {
    await tracker.fail(new Error(error ?? 'integrity failure'));
    log.error({ evidenceId: ev.id, error }, 'integrity check FAILED');
  }
  return { status: ok ? 'OK' : 'FAILED', reason: error ?? undefined, actualSha256: actual?.sha256 ?? null };
}
