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
import { appendAudit } from '@ksp/core';
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
      const now = new Date();
      await tx.updateTable('evidence').set({ status: 'DISPOSED', status_reason: `Disposed under authorised request ${dr.id}`, disposed_at: now }).where('id', '=', ev.id).execute();
      await tx.updateTable('evidence_storage_copies').set({ status: 'DISPOSED', status_note: 'deleted by authorised disposal' }).where('evidence_id', '=', ev.id).where('status', 'in', ['CURRENT', 'RETAINED']).execute();
      const result = { versionsDeleted, derivedDeleted };
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
