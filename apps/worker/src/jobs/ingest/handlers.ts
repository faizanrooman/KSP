/**
 * Ingestion job handlers (kept separate from the pg-boss registration so tests can run them in-process).
 */
import { sql } from 'kysely';
import { QUEUES, type IngestFinalizePayload } from '@ksp/shared';
import { IngestError, appendAudit, enqueue, finalizeUpload, markIngestFailed, systemActor, type IngestDeps, type IngestOutcome } from '@ksp/core';
import type { WorkerContext } from '../../lib/context.js';
import { ProcessingTracker } from '../../lib/processing.js';

export const EXPIRE_SCHEDULE = 'uploads.expire';
const actor = systemActor('ingest-worker');

export interface FinalizeJob {
  id: string;
  data: IngestFinalizePayload;
  retryCount?: number;
  retryLimit?: number;
}

type Ctx = Pick<WorkerContext, 'db' | 'storage' | 'cfg' | 'log'>;

function deps(ctx: Ctx, extra: Partial<IngestDeps> = {}): IngestDeps {
  return { db: ctx.db, storage: ctx.storage, cfg: ctx.cfg, log: ctx.log, ...extra };
}

/**
 * INGEST_FINALIZE handler. Throws on retryable failure (pg-boss retries with backoff). On the final
 * attempt — or a permanent error — the item is quarantined for manual review, the failure is audited and an
 * UPLOAD_FAILED alert is raised.
 */
export async function handleFinalize(ctx: Ctx, job: FinalizeJob, extra: Partial<IngestDeps> = {}): Promise<IngestOutcome | null> {
  const sessionId = job.data?.uploadSessionId;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    ctx.log.error({ jobId: job.id }, 'ingest.finalize: invalid payload');
    return null;
  }
  const session = await ctx.db.selectFrom('upload_sessions').select(['evidence_id']).where('id', '=', sessionId).executeTakeFirst();
  if (!session) {
    ctx.log.error({ jobId: job.id, uploadSessionId: sessionId }, 'ingest.finalize: unknown upload session (not retried)');
    return null;
  }
  const tracker = await ProcessingTracker.start(ctx.db, { kind: 'VALIDATE_REGISTER', uploadSessionId: sessionId, evidenceId: session.evidence_id, queueJobId: job.id });
  try {
    const out = await finalizeUpload(deps(ctx, { onProgress: (f) => tracker.progress(f), ...extra }), sessionId);
    await tracker.complete(out);
    return out;
  } catch (err) {
    const permanent = err instanceof IngestError && err.permanent;
    const final = permanent || (job.retryLimit !== undefined && (job.retryCount ?? 0) >= job.retryLimit);
    await tracker.fail(err);
    ctx.log.error({ err, uploadSessionId: sessionId, attempt: (job.retryCount ?? 0) + 1, final }, 'ingest.finalize failed');
    if (final) await recordFinalFailure(ctx, sessionId, err);
    if (permanent) return null;
    throw err;
  }
}

export async function recordFinalFailure(ctx: Ctx, sessionId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { evidenceId, orgUnitId } = await markIngestFailed(deps(ctx), sessionId, message);
  await appendAudit(ctx.db, actor, {
    action: 'UPLOAD_FAILED',
    outcome: 'FAILURE',
    resourceType: 'upload_session',
    resourceId: sessionId,
    evidenceId,
    orgUnitId,
    details: { stage: 'FINALIZE', error: message.slice(0, 1000) },
  });
  await raiseAlert(ctx, {
    ruleCode: 'UPLOAD_FAILED',
    severity: 'WARNING',
    title: 'Evidence ingestion failed',
    message: `Upload ${sessionId} could not be validated/registered after all retries: ${message.slice(0, 500)}. The item was quarantined (PROCESSING_FAILED) for manual review.`,
    resourceType: 'upload_session',
    resourceId: sessionId,
    orgUnitId,
    dedupeKey: `UPLOAD_FAILED:${sessionId}`,
  });
}

export async function raiseAlert(
  ctx: Pick<Ctx, 'db'>,
  a: { ruleCode: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; message: string; resourceType?: string; resourceId?: string; orgUnitId?: string | null; dedupeKey: string },
): Promise<void> {
  await sql`
    INSERT INTO alerts (rule_code, severity, title, message, resource_type, resource_id, org_unit_id, dedupe_key)
    VALUES (${a.ruleCode}, ${a.severity}, ${a.title}, ${a.message}, ${a.resourceType ?? null}, ${a.resourceId ?? null}, ${a.orgUnitId ?? null}::uuid, ${a.dedupeKey})
    ON CONFLICT (dedupe_key) WHERE status <> 'RESOLVED' AND dedupe_key IS NOT NULL
    DO UPDATE SET occurrences = alerts.occurrences + 1, last_seen_at = now(), message = EXCLUDED.message`.execute(ctx.db);
}

/**
 * Cron uploads.expire: abort expired, unfinished sessions (frees S3 multipart storage) and re-request
 * finalisation for completed uploads whose job was lost (enqueue failure after commit).
 */
export async function expireUploads(ctx: Ctx, opts: { limit?: number; enqueueFinalize?: (sessionId: string) => Promise<unknown> } = {}): Promise<{ expired: number; requeued: number }> {
  const limit = opts.limit ?? 500;
  const expired = await ctx.db
    .selectFrom('upload_sessions')
    .select(['id', 'staging_bucket', 'staging_key', 's3_upload_id', 'org_unit_id', 'original_filename', 'received_bytes', 'status'])
    .where('status', 'in', ['INITIATED', 'UPLOADING'])
    .where('expires_at', '<', new Date())
    .orderBy('expires_at')
    .limit(limit)
    .execute();
  let n = 0;
  for (const s of expired) {
    const changed = await ctx.db.transaction().execute(async (tx) => {
      const res = await tx.updateTable('upload_sessions').set({ status: 'EXPIRED', error: 'Upload session expired before completion' }).where('id', '=', s.id).where('status', 'in', ['INITIATED', 'UPLOADING']).executeTakeFirst();
      if (!res.numUpdatedRows) return false;
      await appendAudit(tx, actor, {
        action: 'UPLOAD_ABORTED',
        resourceType: 'upload_session',
        resourceId: s.id,
        orgUnitId: s.org_unit_id,
        details: { reason: 'EXPIRED', filename: s.original_filename, receivedBytes: Number(s.received_bytes) },
      });
      return true;
    });
    if (!changed) continue;
    n++;
    if (s.s3_upload_id) await ctx.storage.abortMultipart(s.staging_bucket, s.staging_key, s.s3_upload_id);
  }
  const stale = await ctx.db
    .selectFrom('upload_sessions as s')
    .innerJoin('evidence as e', 'e.id', 's.evidence_id')
    .select('s.id')
    .where('s.status', '=', 'COMPLETED')
    .where('e.status', '=', 'RECEIVED')
    .where('e.created_at', '<', new Date(Date.now() - 10 * 60_000))
    .limit(limit)
    .execute();
  const send = opts.enqueueFinalize ?? ((id: string) => enqueue(QUEUES.INGEST_FINALIZE, { uploadSessionId: id } satisfies IngestFinalizePayload, { singletonKey: `ingest:${id}` }));
  for (const s of stale) await send(s.id);
  if (n || stale.length) ctx.log.info({ expired: n, requeued: stale.length }, 'uploads.expire');
  return { expired: n, requeued: stale.length };
}
