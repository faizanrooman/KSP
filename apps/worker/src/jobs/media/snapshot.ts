/**
 * media.snapshot (FN-8): exact-frame PNG extraction moved out of the API process. The API has already authorised the
 * request (loadEvidenceFor 'evidence:snapshot'), resolved the source object and frame number, and stored them in
 * snapshot_requests; this job decodes the frame (core extractFrame), stores the PNG in the derived bucket and inserts
 * the SNAPSHOT derivative + EVIDENCE_SNAPSHOT_CREATED custody event (actor = requesting user) in one transaction.
 * Extraction failures are deterministic (bad position / undecodable frame): the request is marked FAILED, not retried.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendAudit, extractFrame, type AppConfig, type AuditActor, type Database, type Storage } from '@ksp/core';

export interface SnapshotDeps { db: Database; storage: Storage; cfg: AppConfig; log?: { warn: (o: object, m: string) => void } }
interface Params { timeMs: number; source: 'proxy' | 'original'; frame: number; fps: number; bucket: string; key: string; versionId: string | null }

export async function runSnapshotExtract(deps: SnapshotDeps, requestId: string): Promise<{ status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; derivativeId?: string; error?: string }> {
  const { db, storage, cfg } = deps;
  const claimed = await db.updateTable('snapshot_requests').set({ status: 'RUNNING' }).where('id', '=', requestId).where('status', '=', 'QUEUED').returningAll().executeTakeFirst();
  if (!claimed) return { status: 'SKIPPED' };
  const prm = claimed.params as unknown as Params;
  const ev = await db.selectFrom('evidence').select(['id', 'org_unit_id', 'status']).where('id', '=', claimed.evidence_id).executeTakeFirstOrThrow();
  const fail = async (error: string) => {
    await db.updateTable('snapshot_requests').set({ status: 'FAILED', error: error.slice(0, 1000), finished_at: new Date() }).where('id', '=', requestId).execute();
    return { status: 'FAILED' as const, error };
  };
  if (!['REGISTERED', 'DISPOSAL_PENDING'].includes(ev.status)) return fail('Evidence is not available');
  let snap: { png: Buffer; width: number; height: number };
  try {
    const input = await storage.internalUrl(prm.bucket, prm.key, 600, prm.versionId ?? undefined);
    snap = await extractFrame({ input, frame: prm.frame, fps: prm.fps, workDir: cfg.WORK_DIR });
  } catch (err) {
    deps.log?.warn({ requestId, err: (err as Error).message }, 'snapshot extraction failed');
    return fail('Frame could not be extracted at this position');
  }
  const sha256 = createHash('sha256').update(snap.png).digest('hex');
  const id = randomUUID();
  const bucket = storage.bucket('derived');
  const key = `evidence/${ev.id}/snapshot/${id}.png`;
  await storage.put(bucket, key, snap.png, { contentType: 'image/png', metadata: { sha256 } });
  const meta = { timeMs: prm.timeMs, frameNumber: prm.frame, frameTimeMs: Math.round((prm.frame / prm.fps) * 1000 * 1000) / 1000, fps: prm.fps, source: prm.source, sha256 };
  try {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('evidence_derivatives')
        .values({ id, evidence_id: ev.id, kind: 'SNAPSHOT', bucket, object_key: key, mime_type: 'image/png', size_bytes: snap.png.length, sha256, width: snap.width, height: snap.height, meta: JSON.stringify(meta), created_by: claimed.requested_by })
        .execute();
      await appendAudit(tx, claimed.actor as unknown as AuditActor, { action: 'EVIDENCE_SNAPSHOT_CREATED', resourceType: 'evidence_derivative', resourceId: id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { ...meta, snapshotRequestId: requestId } });
      await tx.updateTable('snapshot_requests').set({ status: 'COMPLETED', derivative_id: id, finished_at: new Date() }).where('id', '=', requestId).execute();
    });
  } catch (err) {
    await storage.delete(bucket, key).catch(() => undefined);
    await db.updateTable('snapshot_requests').set({ status: 'QUEUED' }).where('id', '=', requestId).where('status', '=', 'RUNNING').execute();
    throw err; // transient (DB) — retried by pg-boss
  }
  return { status: 'COMPLETED', derivativeId: id };
}
