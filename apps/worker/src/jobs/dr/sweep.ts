/**
 * dr.dispose-sweep (OPS-5): disposal must reach the DR store too. For every DR copy recorded by
 * scripts/backup/s3-replicate.ts (dr_object_copies) whose evidence is DISPOSED, delete that exact version from the DR
 * store (governance bypass when DR_S3_BYPASS_GOVERNANCE, default on). Success → DELETED + EVIDENCE_DR_COPY_DELETED;
 * refusal (COMPLIANCE lock, missing permission, store down) → DELETE_FAILED with the error, attempts+1 and
 * EVIDENCE_DR_COPY_DELETE_FAILED (outcome FAILURE); the next sweep retries. A copy already absent counts as deleted.
 * Copies without a recorded version id (unversioned DR bucket or legacy rows) delete every version of the key.
 * Also available as a CLI: `npm run -w @ksp/worker dr:dispose-sweep`.
 */
import { appendAudit, drStoreFromEnv, systemActor, type Database, type DrStore } from '@ksp/core';

const ACTOR = systemActor('dr-dispose-sweep');
export const DR_SWEEP_MAX_ATTEMPTS = 20;

export interface DrSweepResult { configured: boolean; candidates: number; deleted: number; failed: number; errors: string[] }

const isMissing = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x.name === 'NoSuchKey' || x.name === 'NotFound' || x.name === 'NoSuchVersion' || x.$metadata?.httpStatusCode === 404;
};

export async function runDrDisposeSweep(db: Database, opts: { store?: DrStore | null; limit?: number } = {}): Promise<DrSweepResult> {
  const store = opts.store === undefined ? drStoreFromEnv() : opts.store;
  const out: DrSweepResult = { configured: !!store, candidates: 0, deleted: 0, failed: 0, errors: [] };
  if (!store) return out;
  const rows = await db
    .selectFrom('dr_object_copies as c')
    .innerJoin('evidence as e', 'e.id', 'c.evidence_id')
    .select(['c.id', 'c.evidence_id', 'c.kind', 'c.bucket', 'c.object_key', 'c.version_id', 'c.sha256', 'c.attempts', 'e.org_unit_id', 'e.evidence_number'])
    .where('e.status', '=', 'DISPOSED')
    .where('c.status', 'in', ['PRESENT', 'DELETE_FAILED'])
    .where('c.attempts', '<', DR_SWEEP_MAX_ATTEMPTS)
    .orderBy('c.id')
    .limit(opts.limit ?? 1000)
    .execute();
  out.candidates = rows.length;
  for (const c of rows) {
    let error: string | null = null;
    let versions: string[] = [];
    try {
      versions = c.version_id ? [c.version_id] : await store.listVersions(c.bucket, c.object_key);
      for (const v of versions) {
        try {
          await store.deleteVersion(c.bucket, c.object_key, v === 'null' ? null : v);
        } catch (e) {
          if (!isMissing(e)) throw e;
        }
      }
    } catch (e) {
      const x = e as { name?: string; message?: string };
      error = `${x.name ?? 'Error'}: ${x.message ?? String(e)}`.slice(0, 500);
    }
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('dr_object_copies')
        .set(error ? { status: 'DELETE_FAILED', attempts: c.attempts + 1, last_error: error } : { status: 'DELETED', deleted_at: new Date(), attempts: c.attempts + 1, last_error: null })
        .where('id', '=', c.id).execute();
      await appendAudit(tx, ACTOR, {
        action: error ? 'EVIDENCE_DR_COPY_DELETE_FAILED' : 'EVIDENCE_DR_COPY_DELETED', outcome: error ? 'FAILURE' : 'SUCCESS',
        resourceType: 'evidence', resourceId: c.evidence_id!, evidenceId: c.evidence_id, orgUnitId: c.org_unit_id,
        details: { store: store.endpoint, bucket: c.bucket, key: c.object_key, kind: c.kind, versionId: c.version_id, versionsDeleted: error ? 0 : versions.length, sha256: c.sha256, bypassGovernance: store.bypassGovernance, attempt: c.attempts + 1, error },
      });
    });
    if (error) {
      out.failed++;
      out.errors.push(`${c.evidence_number ?? c.evidence_id} ${c.bucket}/${c.object_key}: ${error}`);
    } else out.deleted++;
  }
  return out;
}
