/**
 * Execute an APPROVED disposal request: delete every stored version of the original in all tier buckets
 * (governance bypass), delete derived artefacts, then mark the evidence DISPOSED. The evidence row and its
 * audit trail are kept forever. If the store refuses any deletion the request stays APPROVED with the error
 * recorded — success is never faked.
 *
 * The evidence row is locked (FOR UPDATE) for the whole execution so a concurrent legal hold cannot slip in
 * between the checks and the storage deletion.
 */
import { sql } from 'kysely';
import { appendAudit, type Storage, type Tx } from '@ksp/core';
import type { DisposalExecutePayload } from '@ksp/shared';
import { ProcessingTracker } from '../../lib/processing.js';
import { ACTOR, errText, listVersions, noopLog, type LifecycleDeps } from './common.js';

export interface DisposalResult {
  status: 'EXECUTED' | 'FAILED' | 'SKIPPED';
  reason?: string;
  versionsDeleted?: number;
  derivedDeleted?: number;
  failures?: string[];
}

class DisposalBlocked extends Error {}

/**
 * Everything derived from the evidence outside its own prefixes (tender §57/§68): biometric / plate data on AI
 * detections (the review record itself is kept), face-search results, court export packages and shares that still
 * expose it, and crops copied into AI training datasets. Runs inside the disposal transaction.
 */
async function purgeDependents(tx: Tx, storage: Storage, ev: { id: string; org_unit_id: string }, requestId: string) {
  const reason = `Evidence disposed under authorised request ${requestId}`;
  // AI: drop face embeddings, crop references, plate text and watchlist matches; label / review history stay.
  const ai = await sql<{ id: string }>`UPDATE ai_detections SET embedding = NULL, crop_key = NULL,
      attributes = COALESCE(attributes, '{}'::jsonb) - 'plateText' - 'watchlistEntryId' - 'watchlistId' - 'similarity' - 'matches'
    WHERE evidence_id = ${ev.id}::uuid RETURNING id`.execute(tx);
  const detectionIds = ai.rows.map((r) => r.id);
  // Repository face searches no longer list the item.
  const fs = await sql`UPDATE face_searches SET result = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(result) x WHERE x->>'evidenceId' <> ${ev.id})
    WHERE result IS NOT NULL AND result @> jsonb_build_array(jsonb_build_object('evidenceId', ${ev.id}::text))`.execute(tx);
  // Court exports containing the item that are not finished or still downloadable: revoked, package deleted.
  const exports = await tx.selectFrom('exports as x').innerJoin('export_items as xi', 'xi.export_id', 'x.id')
    .select(['x.id', 'x.status', 'x.bucket', 'x.object_key', 'x.export_number']).where('xi.evidence_id', '=', ev.id)
    .where('x.status', 'in', ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'READY']).execute();
  const packageErrors: string[] = [];
  for (const x of exports) {
    await tx.updateTable('exports').set({ status: 'REVOKED', revoked_at: new Date(), revoke_reason: reason }).where('id', '=', x.id).execute();
    await appendAudit(tx, ACTOR, { action: 'EXPORT_REVOKED', resourceType: 'export', resourceId: x.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason, previousStatus: x.status, exportNumber: x.export_number, packageDeleted: !!x.object_key } });
    if (x.bucket && x.object_key) await storage.delete(x.bucket, x.object_key).catch((err) => packageErrors.push(`${x.export_number}: ${errText(err)}`));
  }
  // Shares whose every item is now disposed: revoked (the portal already hides disposed items of mixed shares).
  const shares = await sql<{ id: string }>`UPDATE shares s SET status = 'REVOKED', revoked_at = now(), revoke_reason = ${reason}
    WHERE s.status IN ('ACTIVE', 'LOCKED') AND EXISTS (SELECT 1 FROM share_items si WHERE si.share_id = s.id AND si.evidence_id = ${ev.id}::uuid)
      AND NOT EXISTS (SELECT 1 FROM share_items si JOIN evidence e ON e.id = si.evidence_id WHERE si.share_id = s.id AND e.id <> ${ev.id}::uuid AND e.status <> 'DISPOSED')
    RETURNING s.id`.execute(tx);
  for (const s of shares.rows) {
    await appendAudit(tx, ACTOR, { action: 'SHARE_REVOKED', resourceType: 'share', resourceId: s.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason } });
  }
  // Crops of this evidence copied into completed AI training datasets.
  let trainingCrops = 0;
  if (detectionIds.length) {
    const sets = await tx.selectFrom('ai_training_exports').select(['bucket', 'object_key']).where('status', '=', 'COMPLETED').where('object_key', 'is not', null).execute();
    for (const t of sets) {
      for (const id of detectionIds) {
        try {
          if (await storage.head(t.bucket!, `${t.object_key}crops/${id}.jpg`)) {
            await storage.delete(t.bucket!, `${t.object_key}crops/${id}.jpg`);
            trainingCrops++;
          }
        } catch (err) {
          packageErrors.push(`training crop ${id}: ${errText(err)}`);
        }
      }
    }
  }
  return {
    aiDetectionsCleared: detectionIds.length, faceSearchesUpdated: Number(fs.numAffectedRows ?? 0), exportsRevoked: exports.length,
    sharesRevoked: shares.rows.length, trainingCropsDeleted: trainingCrops, ...(packageErrors.length ? { cleanupErrors: packageErrors.slice(0, 20) } : {}),
  };
}

export async function runDisposal(deps: LifecycleDeps, payload: DisposalExecutePayload, queueJobId?: string): Promise<DisposalResult> {
  const { db, storage } = deps;
  const log = deps.log ?? noopLog;
  const dr0 = await db.selectFrom('disposal_requests').select(['id', 'status', 'evidence_id']).where('id', '=', payload.disposalRequestId).executeTakeFirst();
  if (!dr0) return { status: 'SKIPPED', reason: 'request not found' };
  if (dr0.status !== 'APPROVED') return { status: 'SKIPPED', reason: `request is ${dr0.status}` };
  const tracker = await ProcessingTracker.start(db, { kind: 'DISPOSE', evidenceId: dr0.evidence_id, queueJobId });
  await db.updateTable('disposal_requests').set((eb) => ({ execution_attempts: eb('execution_attempts', '+', 1) })).where('id', '=', dr0.id).execute();

  const recordFailure = async (reason: string, result: object) => {
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('disposal_requests').set({ execution_error: reason.slice(0, 4000), execution_result: JSON.stringify(result) }).where('id', '=', dr0.id).execute();
      const ev = await tx.selectFrom('evidence').select(['org_unit_id']).where('id', '=', dr0.evidence_id).executeTakeFirstOrThrow();
      await appendAudit(tx, ACTOR, { action: 'EVIDENCE_DISPOSAL_FAILED', outcome: 'FAILURE', resourceType: 'disposal_request', resourceId: dr0.id, evidenceId: dr0.evidence_id, orgUnitId: ev.org_unit_id, details: { reason, ...result } });
    });
    await tracker.fail(new Error(reason));
    log.error({ disposalRequestId: dr0.id, reason }, 'disposal execution failed');
  };

  try {
    const out = await db.transaction().execute(async (tx) => {
      const dr = await tx.selectFrom('disposal_requests').selectAll().where('id', '=', dr0.id).forUpdate().executeTakeFirstOrThrow();
      if (dr.status !== 'APPROVED') throw new DisposalBlocked(`request is ${dr.status}`);
      const ev = await tx
        .selectFrom('evidence')
        .select(['id', 'status', 'legal_hold', 'org_unit_id', 'storage_bucket', 'storage_key', 'evidence_number'])
        .where('id', '=', dr.evidence_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (ev.status === 'DISPOSED') return { already: true as const };
      if (ev.legal_hold) throw new DisposalBlocked('evidence is under legal hold');
      const open = await sql<{ n: number }>`SELECT count(*)::int AS n FROM case_evidence ce JOIN cases c ON c.id = ce.case_id
        WHERE ce.evidence_id = ${ev.id}::uuid AND ce.unlinked_at IS NULL AND c.status NOT IN ('CLOSED','ARCHIVED')`.execute(tx);
      if ((open.rows[0]?.n ?? 0) > 0) throw new DisposalBlocked('evidence is linked to an open case');

      // Every location an original of this evidence may live in: current pointer + copy registry, across all tiers.
      const copies = await tx.selectFrom('evidence_storage_copies').select(['bucket', 'object_key']).where('evidence_id', '=', ev.id).execute();
      const prefixes = new Set<string>();
      const add = (key: string) => prefixes.add(key.slice(0, key.lastIndexOf('/') + 1) || key);
      if (ev.storage_key) add(ev.storage_key);
      for (const c of copies) add(c.object_key);
      const buckets = new Set<string>([storage.bucket('evidence'), storage.bucket('archive'), storage.bucket('longterm')]);
      if (ev.storage_bucket) buckets.add(ev.storage_bucket);
      for (const c of copies) buckets.add(c.bucket);

      const tierLabel = (b: string) => (b === storage.bucket('evidence') ? 'ACTIVE' : b === storage.bucket('archive') ? 'ARCHIVE' : b === storage.bucket('longterm') ? 'LONG_TERM' : 'OTHER');
      const failures: string[] = [];
      let versionsDeleted = 0;
      for (const bucket of buckets) {
        for (const prefix of prefixes) {
          if (!prefix.includes(ev.id)) continue; // never touch anything not namespaced by this evidence id
          const versions = await listVersions(storage, bucket, prefix);
          for (const v of versions) {
            try {
              await storage.delete(bucket, v.key, { versionId: v.versionId, bypassGovernance: true });
              versionsDeleted++;
            } catch (err) {
              failures.push(`${v.deleteMarker ? 'delete marker' : 'version'} in ${tierLabel(bucket)} tier: ${errText(err)}`);
            }
          }
        }
      }
      // Verify nothing remains (a store may acknowledge a delete it did not perform).
      let remaining = 0;
      for (const bucket of buckets) for (const prefix of prefixes) if (prefix.includes(ev.id)) remaining += (await listVersions(storage, bucket, prefix)).length;
      if (failures.length || remaining) {
        return { failed: true as const, failures, versionsDeleted, remaining };
      }
      let derivedDeleted = 0;
      try {
        derivedDeleted = await storage.deletePrefix(storage.bucket('derived'), `evidence/${ev.id}/`);
      } catch (err) {
        return { failed: true as const, failures: [`derived artefacts: ${errText(err)}`], versionsDeleted, remaining: 0 };
      }
      const dependents = await purgeDependents(tx, storage, ev, dr.id);
      const now = new Date();
      await tx.updateTable('evidence').set({ status: 'DISPOSED', status_reason: `Disposed under authorised request ${dr.id}`, disposed_at: now }).where('id', '=', ev.id).execute();
      await tx.updateTable('evidence_storage_copies').set({ status: 'DISPOSED', status_note: 'deleted by authorised disposal' }).where('evidence_id', '=', ev.id).where('status', 'in', ['CURRENT', 'RETAINED']).execute();
      const result = { versionsDeleted, derivedDeleted, ...dependents };
      await tx.updateTable('disposal_requests').set({ status: 'EXECUTED', executed_at: now, execution_error: null, execution_result: JSON.stringify(result) }).where('id', '=', dr.id).execute();
      await appendAudit(tx, ACTOR, {
        action: 'EVIDENCE_DISPOSED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
        details: { disposalRequestId: dr.id, requestedBy: dr.requested_by, approvedBy: dr.decided_by, authorityRef: dr.authority_ref, ...result },
      });
      return { done: true as const, ...result };
    });
    if ('already' in out) {
      await db.updateTable('disposal_requests').set({ status: 'EXECUTED', executed_at: new Date() }).where('id', '=', dr0.id).where('status', '=', 'APPROVED').execute();
      await tracker.complete({ already: true });
      return { status: 'EXECUTED', reason: 'already disposed' };
    }
    if ('failed' in out && out.failed) {
      const failures = out.failures ?? [];
      const reason = `storage refused deletion: ${failures.slice(0, 5).join('; ')}${out.remaining ? ` (${out.remaining} object version(s) remain)` : ''}`;
      await recordFailure(reason, { versionsDeleted: out.versionsDeleted, remaining: out.remaining, failures: failures.slice(0, 20) });
      return { status: 'FAILED', reason, versionsDeleted: out.versionsDeleted, failures };
    }
    await tracker.complete({ versionsDeleted: out.versionsDeleted, derivedDeleted: out.derivedDeleted });
    return { status: 'EXECUTED', versionsDeleted: out.versionsDeleted, derivedDeleted: out.derivedDeleted };
  } catch (err) {
    if (err instanceof DisposalBlocked) {
      await recordFailure(err.message, { blocked: true });
      return { status: 'FAILED', reason: err.message };
    }
    await recordFailure(errText(err), { error: true });
    throw err;
  }
}
