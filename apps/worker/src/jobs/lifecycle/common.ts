/** Shared helpers for the lifecycle worker (fixity, tier migration, disposal, scans). */
import { ListObjectVersionsCommand, PutObjectLegalHoldCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { enqueue as coreEnqueue, raiseAlert as raiseSharedAlert, systemActor, type Database, type Storage, type Tx } from '@ksp/core';
import type { QueueName } from '@ksp/shared';

export interface LifecycleLog {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface LifecycleDeps {
  db: Database;
  storage: Storage;
  log?: LifecycleLog;
  /** Defaults to @ksp/core enqueue (pg-boss). */
  enqueue?: (name: QueueName, data: object, opts?: { singletonKey?: string }) => Promise<string | null>;
}

export const ACTOR = systemActor('lifecycle-worker');
export const STORED_STATUSES = ['REGISTERED', 'DISPOSAL_PENDING'];
export const noopLog: LifecycleLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function enqueueFn(deps: LifecycleDeps) {
  return deps.enqueue ?? ((name: QueueName, data: object, opts?: { singletonKey?: string }) => coreEnqueue(name, data, opts ?? {}));
}

/** Stream an object computing SHA-256 + SHA-512 + size, reporting progress. */
export async function hashWithProgress(stream: Readable, total: number, onProgress?: (f: number) => Promise<void> | void) {
  const h256 = createHash('sha256');
  const h512 = createHash('sha512');
  let size = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    h256.update(b);
    h512.update(b);
    size += b.length;
    if (onProgress && total > 0) await onProgress(Math.min(0.99, size / total));
  }
  return { sha256: h256.digest('hex'), sha512: h512.digest('hex'), size };
}

export function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return ['NoSuchKey', 'NoSuchVersion', 'NotFound', 'NoSuchBucket'].includes(e.name ?? e.Code ?? '') || e.$metadata?.httpStatusCode === 404;
}

export function errText(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e.name ?? 'Error'}: ${e.message ?? String(err)}`.slice(0, 1000);
}

/** Raise (or bump) an alert. Deduplicated on open alerts by dedupe_key. */
export async function raiseAlert(
  db: Database | Tx,
  a: { ruleCode: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; message: string; resourceType?: string; resourceId?: string; orgUnitId?: string | null; dedupeKey: string },
): Promise<void> {
  // Delegates to the shared helper: respects alert_rules.enabled and de-duplicates on open alerts.
  await raiseSharedAlert(db, a);
}

/** All object versions and delete markers stored under `prefix` in `bucket`. */
export async function listVersions(storage: Storage, bucket: string, prefix: string): Promise<Array<{ key: string; versionId?: string; deleteMarker: boolean }>> {
  const out: Array<{ key: string; versionId?: string; deleteMarker: boolean }> = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (;;) {
    const page = await storage.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
    for (const v of page.Versions ?? []) out.push({ key: v.Key!, versionId: v.VersionId, deleteMarker: false });
    for (const m of page.DeleteMarkers ?? []) out.push({ key: m.Key!, versionId: m.VersionId, deleteMarker: true });
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
  }
  return out;
}

export async function setObjectLegalHold(storage: Storage, bucket: string, key: string, versionId: string | null | undefined, on: boolean): Promise<string> {
  try {
    await storage.s3.send(new PutObjectLegalHoldCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined, LegalHold: { Status: on ? 'ON' : 'OFF' } }));
    return 'APPLIED';
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotImplemented' || e.$metadata?.httpStatusCode === 501) return 'NOT_SUPPORTED';
    return `FAILED ${errText(err)}`;
  }
}

/** Make sure the copy registry has a CURRENT row for the evidence's current storage pointer. */
export async function ensureCurrentCopy(
  tx: Tx,
  ev: { id: string; storage_tier: string; storage_bucket: string; storage_key: string; storage_version_id: string | null; sha256: string; object_lock_until: Date | null },
): Promise<void> {
  const cur = await tx.selectFrom('evidence_storage_copies').select(['id', 'bucket', 'object_key', 'version_id']).where('evidence_id', '=', ev.id).where('status', '=', 'CURRENT').executeTakeFirst();
  if (cur && cur.bucket === ev.storage_bucket && cur.object_key === ev.storage_key && cur.version_id === ev.storage_version_id) return;
  if (cur) await tx.updateTable('evidence_storage_copies').set({ status: 'RETAINED', status_note: 'superseded (registry reconciled)' }).where('id', '=', cur.id).execute();
  await tx
    .insertInto('evidence_storage_copies')
    .values({ evidence_id: ev.id, tier: ev.storage_tier, bucket: ev.storage_bucket, object_key: ev.storage_key, version_id: ev.storage_version_id, sha256: ev.sha256, status: 'CURRENT', object_lock_until: ev.object_lock_until })
    .onConflict((oc) => oc.columns(['bucket', 'object_key', 'version_id']).doUpdateSet({ status: 'CURRENT' }))
    .execute();
}
