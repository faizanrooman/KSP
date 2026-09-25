/** Lifecycle helpers shared by the evidence and retention modules. */
import { PutObjectLegalHoldCommand } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import type { Database, Storage, Tx } from '@ksp/core';

export type StorageHoldResult = 'APPLIED' | 'NOT_SUPPORTED' | 'FAILED' | 'NOT_APPLICABLE';

/**
 * Apply/remove an S3 Object Lock legal hold on every stored copy of the original (current + retained copies).
 * The database hold is authoritative; the storage hold is defence in depth. Stores without legal-hold
 * support report NOT_SUPPORTED instead of failing the operation.
 */
export async function setStorageLegalHold(db: Database | Tx, storage: Storage, evidenceId: string, on: boolean): Promise<{ result: StorageHoldResult; note: string | null }> {
  const ev = await db.selectFrom('evidence').select(['storage_bucket', 'storage_key', 'storage_version_id', 'storage_tier']).where('id', '=', evidenceId).executeTakeFirstOrThrow();
  const copies: Array<{ bucket: string; key: string; versionId: string | null }> = [];
  if (ev.storage_bucket && ev.storage_key && ev.storage_tier !== 'STAGING') copies.push({ bucket: ev.storage_bucket, key: ev.storage_key, versionId: ev.storage_version_id });
  const retained = await db.selectFrom('evidence_storage_copies').select(['bucket', 'object_key', 'version_id']).where('evidence_id', '=', evidenceId).where('status', '=', 'RETAINED').execute();
  for (const c of retained) copies.push({ bucket: c.bucket, key: c.object_key, versionId: c.version_id });
  if (!copies.length) return { result: 'NOT_APPLICABLE', note: 'no stored original in an immutable tier' };
  const errors: string[] = [];
  for (const c of copies) {
    try {
      await storage.s3.send(new PutObjectLegalHoldCommand({ Bucket: c.bucket, Key: c.key, VersionId: c.versionId ?? undefined, LegalHold: { Status: on ? 'ON' : 'OFF' } }));
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotImplemented' || e.$metadata?.httpStatusCode === 501) return { result: 'NOT_SUPPORTED', note: 'object store does not implement PutObjectLegalHold' };
      errors.push(`${e.name ?? 'Error'}: ${e.message ?? ''}`.slice(0, 300));
    }
  }
  return errors.length ? { result: 'FAILED', note: errors.join('; ') } : { result: 'APPLIED', note: `${copies.length} stored cop${copies.length === 1 ? 'y' : 'ies'}` };
}

/** SQL expression computing retain_until for evidence alias `e` under policy alias `rp`. */
export const retainUntilSql = sql<Date | null>`CASE WHEN rp.retention_days IS NULL THEN NULL
  ELSE coalesce(e.registered_at, e.created_at) + make_interval(days => rp.retention_days) END`;

/** Linked cases that are still open (block disposal). */
export async function openCaseLinks(db: Database | Tx, evidenceId: string): Promise<Array<{ id: string; case_number: string }>> {
  return db
    .selectFrom('case_evidence as ce')
    .innerJoin('cases as c', 'c.id', 'ce.case_id')
    .select(['c.id', 'c.case_number'])
    .where('ce.evidence_id', '=', evidenceId)
    .where('ce.unlinked_at', 'is', null)
    .where('c.status', 'not in', ['CLOSED', 'ARCHIVED'])
    .execute();
}
