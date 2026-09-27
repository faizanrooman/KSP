/**
 * Scheduled lifecycle scans.
 *  lifecycle.scan  — assign the default retention policy where missing, queue due tier transitions, re-queue
 *                    approved disposals that were never executed, and count disposal candidates (NEVER disposes).
 *  integrity.sweep — queue fixity checks for the least-recently-verified originals.
 */
import { sql } from 'kysely';
import { appendAudit, integrityCoverage, loadIntegrityPolicy, selectFixityCandidates } from '@ksp/core';
import { QUEUES, type FixityCheckPayload, type TierMigratePayload } from '@ksp/shared';
import { ACTOR, enqueueFn, noopLog, type LifecycleDeps } from './common.js';

export interface ScanResult {
  retentionAssigned: number;
  tierQueued: Array<{ evidenceId: string; targetTier: TierMigratePayload['targetTier'] }>;
  disposalsRequeued: number;
  disposalCandidates: number;
}

async function queueTracked(deps: LifecycleDeps, name: (typeof QUEUES)[keyof typeof QUEUES], kind: string, evidenceId: string, data: object, singletonKey: string): Promise<boolean> {
  const id = await enqueueFn(deps)(name, data, { singletonKey });
  if (!id) return false;
  await deps.db.insertInto('processing_jobs').values({ kind, evidence_id: evidenceId, queue_job_id: id, status: 'QUEUED' }).execute();
  return true;
}

export async function runLifecycleScan(deps: LifecycleDeps, opts: { batch?: number; now?: Date } = {}): Promise<ScanResult> {
  const { db } = deps;
  const log = deps.log ?? noopLog;
  const batch = opts.batch ?? 200;
  const now = opts.now ?? new Date();

  // 1. Default retention policy for registered evidence without one.
  let retentionAssigned = 0;
  const def = await db.selectFrom('retention_policies').select(['id', 'name', 'retention_days']).where('is_default', '=', true).executeTakeFirst();
  if (def) {
    const rows = await db.selectFrom('evidence').select(['id', 'org_unit_id']).where('retention_policy_id', 'is', null).where('status', 'in', ['REGISTERED', 'DISPOSAL_PENDING']).limit(batch).execute();
    for (const r of rows) {
      await db.transaction().execute(async (tx) => {
        const upd = await sql<{ retain_until: Date | null }>`UPDATE evidence e SET retention_policy_id = ${def.id}::uuid,
            retain_until = CASE WHEN ${def.retention_days}::int IS NULL THEN NULL ELSE coalesce(e.registered_at, e.created_at) + make_interval(days => ${def.retention_days}::int) END
          WHERE e.id = ${r.id}::uuid AND e.retention_policy_id IS NULL RETURNING e.retain_until`.execute(tx);
        if (!upd.rows.length) return;
        retentionAssigned++;
        await appendAudit(tx, ACTOR, { action: 'EVIDENCE_RETENTION_ASSIGNED', resourceType: 'evidence', resourceId: r.id, evidenceId: r.id, orgUnitId: r.org_unit_id, details: { policyId: def.id, policyName: def.name, retainUntil: upd.rows[0]!.retain_until, automatic: true } });
      });
    }
  }

  // 2. Tier transitions that are due (age measured from registration).
  const due = await sql<{ id: string; target: TierMigratePayload['targetTier'] }>`
    SELECT e.id,
      CASE WHEN rp.long_term_after_days IS NOT NULL AND coalesce(e.registered_at, e.created_at) + make_interval(days => rp.long_term_after_days) <= ${now}
           THEN 'LONG_TERM' ELSE 'ARCHIVE' END AS target
    FROM evidence e JOIN retention_policies rp ON rp.id = e.retention_policy_id
    WHERE e.status = 'REGISTERED' AND e.storage_key IS NOT NULL
      AND (
        (e.storage_tier = 'ACTIVE' AND ((rp.archive_after_days IS NOT NULL AND coalesce(e.registered_at, e.created_at) + make_interval(days => rp.archive_after_days) <= ${now})
                                     OR (rp.long_term_after_days IS NOT NULL AND coalesce(e.registered_at, e.created_at) + make_interval(days => rp.long_term_after_days) <= ${now})))
        OR (e.storage_tier = 'ARCHIVE' AND rp.long_term_after_days IS NOT NULL AND coalesce(e.registered_at, e.created_at) + make_interval(days => rp.long_term_after_days) <= ${now})
      )
      AND NOT EXISTS (SELECT 1 FROM processing_jobs pj WHERE pj.evidence_id = e.id AND pj.kind = 'TIER_MIGRATE' AND pj.status IN ('QUEUED','RUNNING'))
    ORDER BY e.registered_at
    LIMIT ${batch}`.execute(db);
  const tierQueued: ScanResult['tierQueued'] = [];
  for (const r of due.rows) {
    const payload: TierMigratePayload = { evidenceId: r.id, targetTier: r.target };
    if (await queueTracked(deps, QUEUES.TIER_MIGRATE, 'TIER_MIGRATE', r.id, payload, `tier:${r.id}`)) tierQueued.push({ evidenceId: r.id, targetTier: r.target });
  }

  // 3. Approved disposals never picked up (e.g. enqueue failed after approval commit).
  const stale = await db
    .selectFrom('disposal_requests as dr')
    .select(['dr.id', 'dr.evidence_id'])
    .where('dr.status', '=', 'APPROVED')
    .where('dr.execution_attempts', '=', 0)
    .where('dr.decided_at', '<', new Date(now.getTime() - 15 * 60_000))
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM processing_jobs pj WHERE pj.evidence_id = dr.evidence_id AND pj.kind = 'DISPOSE' AND pj.status IN ('QUEUED','RUNNING'))`)
    .limit(batch)
    .execute();
  let disposalsRequeued = 0;
  for (const r of stale) if (await queueTracked(deps, QUEUES.DISPOSAL_EXECUTE, 'DISPOSE', r.evidence_id, { disposalRequestId: r.id }, `dispose:${r.id}`)) disposalsRequeued++;

  // 4. Disposal candidates are only reported; disposal always needs a request + a different approver.
  const cand = await sql<{ n: number }>`SELECT count(*)::int AS n FROM evidence e
    WHERE e.status = 'REGISTERED' AND NOT e.legal_hold AND e.retain_until < ${now}
      AND NOT EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id WHERE ce.evidence_id = e.id AND ce.unlinked_at IS NULL AND c.status NOT IN ('CLOSED','ARCHIVED'))`.execute(db);
  const result = { retentionAssigned, tierQueued, disposalsRequeued, disposalCandidates: cand.rows[0]?.n ?? 0 };
  log.info({ ...result, tierQueued: tierQueued.length }, 'lifecycle scan');
  return result;
}

/**
 * integrity.sweep — nightly fixity batch sized for full coverage: ceil(total copies / integrityPolicy.fullCycleDays)
 * (clamped to min/maxPerNight) within maxBytesPerNight; never-verified first, then recently tier-migrated originals,
 * then the least-recently verified. Covers current originals, RETAINED copies and recorded DR copies.
 * `opts.batch` overrides the computed size (tests / manual runs).
 */
export async function runIntegritySweep(deps: LifecycleDeps, opts: { batch?: number; minAgeHours?: number; maxBytes?: number } = {}): Promise<{ queued: string[]; queuedCopies: Array<{ kind: 'RETAINED' | 'DR'; id: number; evidenceId: string }>; batch: number; bytes: number }> {
  const policy = await loadIntegrityPolicy(deps.db);
  const coverage = await integrityCoverage(deps.db, policy);
  const batch = opts.batch ?? coverage.nightlyBatch;
  const candidates = await selectFixityCandidates(deps.db, { batch, maxBytes: opts.maxBytes ?? policy.maxBytesPerNight, minAgeHours: opts.minAgeHours ?? 24 });
  const queued: string[] = [];
  const queuedCopies: Array<{ kind: 'RETAINED' | 'DR'; id: number; evidenceId: string }> = [];
  let bytes = 0;
  for (const c of candidates) {
    if (c.kind === 'PRIMARY') {
      const payload: FixityCheckPayload = { evidenceId: c.evidenceId, trigger: 'SCHEDULED' };
      if (await queueTracked(deps, QUEUES.FIXITY_CHECK, 'FIXITY_CHECK', c.evidenceId, payload, `fixity:${c.evidenceId}`)) { queued.push(c.evidenceId); bytes += c.sizeBytes; }
    } else {
      const copy = { kind: c.kind, id: c.refId! };
      const payload: FixityCheckPayload = { evidenceId: c.evidenceId, trigger: 'SCHEDULED', copy };
      if (await queueTracked(deps, QUEUES.FIXITY_CHECK, 'FIXITY_CHECK_COPY', c.evidenceId, payload, `fixity:${c.evidenceId}:${c.kind}:${c.refId}`)) { queuedCopies.push({ ...copy, evidenceId: c.evidenceId }); bytes += c.sizeBytes; }
    }
  }
  (deps.log ?? noopLog).info({ queued: queued.length, queuedCopies: queuedCopies.length, batch, bytes, coveragePercent: coverage.coveragePercent, projectedCycleDays: coverage.projectedCycleDays }, 'integrity sweep');
  return { queued, queuedCopies, batch, bytes };
}
