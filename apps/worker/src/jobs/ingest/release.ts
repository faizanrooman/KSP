/**
 * ingest.release (FN-4): execute a quarantine release requested through the API. The (possibly multi-GB) re-hash and
 * the move into immutable storage run here instead of inside the HTTP request. The release audit is written in the
 * registration transaction by registerEvidence, under the releasing user (actor snapshot from the request).
 * Permanent failures (item no longer QUARANTINED, staged object missing / wrong size) mark the request FAILED;
 * transient errors are rethrown for pg-boss retry (the request stays RUNNING, then QUEUED again on retry).
 */
import { IngestError, registerEvidence, type AuditActor, type IngestDeps } from '@ksp/core';

export async function runQuarantineRelease(deps: IngestDeps, requestId: string, attempt: { final: boolean } = { final: false }): Promise<{ status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; outcome?: string; error?: string }> {
  const { db } = deps;
  const req = await db.selectFrom('quarantine_releases').selectAll().where('id', '=', requestId).executeTakeFirst();
  if (!req || req.status === 'COMPLETED' || req.status === 'FAILED') return { status: 'SKIPPED' };
  await db.updateTable('quarantine_releases').set({ status: 'RUNNING', started_at: new Date() }).where('id', '=', req.id).execute();
  const finish = (status: 'COMPLETED' | 'FAILED', v: { outcome?: string; error?: string }) =>
    db.updateTable('quarantine_releases').set({ status, outcome: v.outcome ?? null, error: v.error?.slice(0, 1000) ?? null, finished_at: new Date() }).where('id', '=', req.id).execute();
  try {
    const cur = await db.selectFrom('evidence').select(['status', 'status_reason']).where('id', '=', req.evidence_id).executeTakeFirstOrThrow();
    const out = await registerEvidence(deps, req.evidence_id, req.actor as unknown as AuditActor, { release: { reason: req.reason, previousReason: cur.status_reason } });
    await finish('COMPLETED', { outcome: out.outcome });
    return { status: 'COMPLETED', outcome: out.outcome };
  } catch (err) {
    const permanent = err instanceof IngestError && err.permanent;
    if (permanent || attempt.final) {
      await finish('FAILED', { error: (err as Error).message });
      return { status: 'FAILED', error: (err as Error).message };
    }
    await db.updateTable('quarantine_releases').set({ status: 'QUEUED', error: (err as Error).message.slice(0, 1000) }).where('id', '=', req.id).execute();
    throw err;
  }
}
