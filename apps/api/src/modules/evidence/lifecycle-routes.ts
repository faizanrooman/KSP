/**
 * Evidence integrity & lifecycle (spec modules 5, 6): legal hold, fixity verification, retention assignment,
 * storage tier moves and the separation-of-duties disposal workflow. Registered inside the /evidence plugin.
 * Execution of fixity / tier migration / disposal happens in the worker (apps/worker/src/jobs/lifecycle).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, enqueue, type AuditActor, type Database } from '@ksp/core';
import { QUEUES, type DisposalExecutePayload, type FixityCheckPayload, type QueueName, type TierMigratePayload } from '@ksp/shared';
import { evidenceVisibleSql, loadEvidenceFor } from '../../lib/access.js';
import { hasPermission, hasPermissionAt, type Principal } from '../../lib/principal.js';
import { AppError, conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { openCaseLinks, retainUntilSql, setStorageLegalHold } from './lifecycle.js';

const idParams = z.object({ id: z.string().uuid() });
const reqParams = z.object({ requestId: z.string().uuid() });
const STORED = ['REGISTERED', 'DISPOSAL_PENDING'];

/** Enqueue a job and create its user-visible processing_jobs row (the worker's tracker reuses it). */
export async function queueJob(db: Database, name: QueueName, kind: string, payload: object, opts: { evidenceId: string; singletonKey: string }): Promise<{ queued: boolean; jobId: string | null }> {
  const queueJobId = await enqueue(name, payload, { singletonKey: opts.singletonKey });
  if (!queueJobId) return { queued: false, jobId: null };
  const row = await db.insertInto('processing_jobs').values({ kind, evidence_id: opts.evidenceId, queue_job_id: queueJobId, status: 'QUEUED' }).returning('id').executeTakeFirstOrThrow();
  return { queued: true, jobId: row.id };
}

function disposalDto(r: DisposalRow, p: Principal) {
  const own = r.requested_by === p.userId;
  const approver = hasPermissionAt(p, 'evidence:dispose_approve', r.org_path);
  return {
    id: r.id,
    evidence: { id: r.evidence_id, evidenceNumber: r.evidence_number, title: r.title, status: r.ev_status, legalHold: r.legal_hold, orgUnit: { id: r.org_id, name: r.org_name } },
    requestedBy: { id: r.requested_by, fullName: r.req_name },
    reason: r.reason,
    authorityRef: r.authority_ref,
    authorityType: r.authority_type,
    authorityDate: r.authority_date,
    early: r.early,
    retainUntilAtRequest: r.retain_until_at_request,
    status: r.status,
    decidedBy: r.decided_by ? { id: r.decided_by, fullName: r.dec_name } : null,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    executedAt: r.executed_at,
    executionAttempts: r.execution_attempts,
    executionError: r.execution_error,
    executionResult: r.execution_result,
    createdAt: r.created_at,
    canDecide: r.status === 'PENDING' && approver && !own && !r.legal_hold,
    canCancel: r.status === 'PENDING' && own,
    canRetry: r.status === 'APPROVED' && approver && !!r.execution_error,
  };
}

function disposalQuery(db: Database) {
  return db
    .selectFrom('disposal_requests as dr')
    .innerJoin('evidence as e', 'e.id', 'dr.evidence_id')
    .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .innerJoin('users as rq', 'rq.id', 'dr.requested_by')
    .leftJoin('users as dc', 'dc.id', 'dr.decided_by')
    .select([
      'dr.id', 'dr.evidence_id', 'dr.requested_by', 'dr.reason', 'dr.authority_ref', 'dr.authority_type', 'dr.authority_date', 'dr.early', 'dr.retain_until_at_request', 'dr.status', 'dr.decided_by', 'dr.decided_at', 'dr.decision_note',
      'dr.executed_at', 'dr.execution_attempts', 'dr.execution_error', 'dr.execution_result', 'dr.created_at',
      'e.evidence_number', 'e.title', 'e.status as ev_status', 'e.legal_hold', 'e.org_path', 'o.id as org_id', 'o.name as org_name',
      'rq.full_name as req_name', 'dc.full_name as dec_name',
    ]);
}
type DisposalRow = Awaited<ReturnType<ReturnType<typeof disposalQuery>['executeTakeFirstOrThrow']>>;

export default async function lifecycleRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------- legal hold
  const holdBody = z.object({ reason: z.string().trim().min(5).max(2000) }).strict();

  app.post('/:id/legal-hold', { schema: { tags: ['evidence-lifecycle'], summary: 'Place a legal hold (blocks disposal; also applies an S3 Object Lock legal hold)', params: idParams, body: holdBody } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:legal_hold', req.actor());
    if (ev.status === 'DISPOSED') throw conflict('Disposed evidence cannot be placed on hold');
    const cur = await app.db.selectFrom('evidence').select('legal_hold').where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (cur.legal_hold) throw conflict('Evidence is already under legal hold');
    const storageHold = await setStorageLegalHold(app.db, app.storage, ev.id, true);
    await app.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('evidence').set({ legal_hold: true, legal_hold_reason: req.body.reason, legal_hold_by: p.userId, legal_hold_at: new Date() }).where('id', '=', ev.id).where('legal_hold', '=', false).executeTakeFirst();
      if (!upd.numUpdatedRows) throw conflict('Evidence is already under legal hold');
      await tx.insertInto('evidence_legal_hold_events').values({ evidence_id: ev.id, action: 'SET', reason: req.body.reason, actor_id: p.userId!, storage_hold: storageHold.result, storage_note: storageHold.note }).execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_LEGAL_HOLD_SET', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason: req.body.reason, storageHold: storageHold.result, storageNote: storageHold.note } });
    });
    return { legalHold: true, storageHold: storageHold.result, storageNote: storageHold.note };
  });

  app.delete('/:id/legal-hold', { schema: { tags: ['evidence-lifecycle'], summary: 'Release a legal hold', params: idParams, body: holdBody } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:legal_hold', req.actor());
    const cur = await app.db.selectFrom('evidence').select('legal_hold').where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (!cur.legal_hold) throw conflict('Evidence is not under legal hold');
    const storageHold = await setStorageLegalHold(app.db, app.storage, ev.id, false);
    try {
      await app.db.transaction().execute(async (tx) => {
        const upd = await tx.updateTable('evidence').set({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null }).where('id', '=', ev.id).where('legal_hold', '=', true).executeTakeFirst();
        if (!upd.numUpdatedRows) throw conflict('Evidence is not under legal hold');
        await tx.insertInto('evidence_legal_hold_events').values({ evidence_id: ev.id, action: 'RELEASED', reason: req.body.reason, actor_id: p.userId!, storage_hold: storageHold.result, storage_note: storageHold.note }).execute();
        await appendAudit(tx, req.actor(), { action: 'EVIDENCE_LEGAL_HOLD_RELEASED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason: req.body.reason, storageHold: storageHold.result, storageNote: storageHold.note } });
      });
    } catch (err) {
      // The DB hold is still in place: restore the storage hold so both layers agree.
      if (storageHold.result === 'APPLIED') await setStorageLegalHold(app.db, app.storage, ev.id, true).catch(() => undefined);
      throw err;
    }
    return { legalHold: false, storageHold: storageHold.result, storageNote: storageHold.note };
  });

  // ---------------------------------------------------------------- integrity
  app.post('/:id/verify', { schema: { tags: ['evidence-lifecycle'], summary: 'Queue an on-demand fixity (SHA-256/SHA-512 re-hash) check', params: idParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:verify', req.actor());
    if (!STORED.includes(ev.status)) throw conflict('Only registered evidence with a stored original can be verified');
    const payload: FixityCheckPayload = { evidenceId: ev.id, trigger: 'ON_DEMAND', requestedBy: p.userId ?? undefined };
    const res = await queueJob(app.db, QUEUES.FIXITY_CHECK, 'FIXITY_CHECK', payload, { evidenceId: ev.id, singletonKey: `fixity:${ev.id}` });
    await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_INTEGRITY_CHECK_REQUESTED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { queued: res.queued } });
    return reply.status(202).send({ queued: res.queued, alreadyQueued: !res.queued, jobId: res.jobId });
  });

  app.get('/:id/integrity', { schema: { tags: ['evidence-lifecycle'], summary: 'Integrity check history', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
    const e = await app.db.selectFrom('evidence').select(['sha256', 'sha512', 'size_bytes', 'last_verified_at']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    const rows = await app.db
      .selectFrom('integrity_checks as ic')
      .leftJoin('users as u', 'u.id', 'ic.requested_by')
      .select(['ic.id', 'ic.trigger', 'ic.expected_sha256', 'ic.actual_sha256', 'ic.ok', 'ic.error', 'ic.checked_at', 'u.id as u_id', 'u.full_name as u_name'])
      .where('ic.evidence_id', '=', ev.id)
      .orderBy('ic.checked_at', 'desc')
      .limit(200)
      .execute();
    const pending = await app.db.selectFrom('processing_jobs').select(['id', 'status']).where('evidence_id', '=', ev.id).where('kind', '=', 'FIXITY_CHECK').where('status', 'in', ['QUEUED', 'RUNNING']).executeTakeFirst();
    return {
      sha256: e.sha256,
      sha512: e.sha512,
      sizeBytes: e.size_bytes,
      lastVerifiedAt: e.last_verified_at,
      lastResult: rows[0] ? (rows[0].ok ? 'OK' : 'FAILED') : null,
      pendingJob: pending ? { id: pending.id, status: pending.status } : null,
      items: rows.map((r) => ({ id: Number(r.id), trigger: r.trigger, expectedSha256: r.expected_sha256, actualSha256: r.actual_sha256, ok: r.ok, error: r.error, checkedAt: r.checked_at, requestedBy: r.u_id ? { id: r.u_id, fullName: r.u_name } : null })),
    };
  });

  // ---------------------------------------------------------------- lifecycle overview
  app.get('/:id/lifecycle', { schema: { tags: ['evidence-lifecycle'], summary: 'Retention, tier history, legal hold history and disposal requests', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
    const e = await app.db
      .selectFrom('evidence as e')
      .leftJoin('retention_policies as rp', 'rp.id', 'e.retention_policy_id')
      .select(['e.storage_tier', 'e.object_lock_until', 'e.retain_until', 'e.archived_at', 'e.disposed_at', 'e.registered_at', 'e.legal_hold', 'rp.id as rp_id', 'rp.name as rp_name', 'rp.retention_days', 'rp.archive_after_days', 'rp.long_term_after_days'])
      .where('e.id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const copies = await app.db.selectFrom('evidence_storage_copies').select(['id', 'tier', 'status', 'status_note', 'object_lock_until', 'created_at', 'updated_at']).where('evidence_id', '=', ev.id).orderBy('created_at').execute();
    const holds = await app.db
      .selectFrom('evidence_legal_hold_events as h')
      .innerJoin('users as u', 'u.id', 'h.actor_id')
      .select(['h.id', 'h.action', 'h.reason', 'h.storage_hold', 'h.storage_note', 'h.created_at', 'u.id as u_id', 'u.full_name as u_name'])
      .where('h.evidence_id', '=', ev.id)
      .orderBy('h.created_at', 'desc')
      .execute();
    const disposals = await disposalQuery(app.db).where('dr.evidence_id', '=', ev.id).orderBy('dr.created_at', 'desc').execute();
    const openCases = await openCaseLinks(app.db, ev.id);
    return {
      storageTier: e.storage_tier,
      objectLockUntil: e.object_lock_until,
      archivedAt: e.archived_at,
      disposedAt: e.disposed_at,
      registeredAt: e.registered_at,
      retainUntil: e.retain_until,
      retentionPolicy: e.rp_id ? { id: e.rp_id, name: e.rp_name, retentionDays: e.retention_days, archiveAfterDays: e.archive_after_days, longTermAfterDays: e.long_term_after_days } : null,
      legalHold: e.legal_hold,
      openCaseCount: openCases.length,
      storageCopies: copies.map((c) => ({ id: Number(c.id), tier: c.tier, status: c.status, note: c.status_note, objectLockUntil: c.object_lock_until, createdAt: c.created_at, updatedAt: c.updated_at })),
      legalHoldHistory: holds.map((h) => ({ id: Number(h.id), action: h.action, reason: h.reason, storageHold: h.storage_hold, storageNote: h.storage_note, at: h.created_at, by: { id: h.u_id, fullName: h.u_name } })),
      disposalRequests: disposals.map((d) => disposalDto(d, p)),
    };
  });

  // ---------------------------------------------------------------- retention & tiers
  app.post('/:id/retention', { schema: { tags: ['evidence-lifecycle'], summary: 'Assign a retention policy (recomputes retain-until)', params: idParams, body: z.object({ policyId: z.string().uuid() }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'retention:manage', req.actor());
    if (!STORED.includes(ev.status)) throw conflict('Retention can only be assigned to registered evidence');
    const policy = await app.db.selectFrom('retention_policies').select(['id', 'name']).where('id', '=', req.body.policyId).executeTakeFirst();
    if (!policy) throw notFound('Retention policy');
    const out = await app.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('evidence').select(['retention_policy_id', 'retain_until']).where('id', '=', ev.id).forUpdate().executeTakeFirstOrThrow();
      await tx.updateTable('evidence').set({ retention_policy_id: policy.id }).where('id', '=', ev.id).execute();
      const after = await sql<{ retain_until: Date | null }>`UPDATE evidence e SET retain_until = ${retainUntilSql} FROM retention_policies rp
        WHERE rp.id = e.retention_policy_id AND e.id = ${ev.id}::uuid RETURNING e.retain_until`.execute(tx);
      const retainUntil = after.rows[0]?.retain_until ?? null;
      await appendAudit(tx, req.actor(), {
        action: 'EVIDENCE_RETENTION_ASSIGNED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
        details: { before: { policyId: before.retention_policy_id, retainUntil: before.retain_until }, after: { policyId: policy.id, policyName: policy.name, retainUntil } },
      });
      return { retainUntil };
    });
    return { retentionPolicy: policy, retainUntil: out.retainUntil };
  });

  app.post('/:id/tier', { schema: { tags: ['evidence-lifecycle'], summary: 'Move the original to another storage tier (copy, re-hash, verify, switch)', params: idParams, body: z.object({ targetTier: z.enum(['ACTIVE', 'ARCHIVE', 'LONG_TERM']) }).strict() } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'retention:manage', req.actor());
    if (!STORED.includes(ev.status)) throw conflict('Only registered evidence can change tier');
    const cur = await app.db.selectFrom('evidence').select('storage_tier').where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (cur.storage_tier === req.body.targetTier) throw conflict(`Evidence is already in the ${req.body.targetTier} tier`);
    const payload: TierMigratePayload = { evidenceId: ev.id, targetTier: req.body.targetTier };
    const res = await queueJob(app.db, QUEUES.TIER_MIGRATE, 'TIER_MIGRATE', payload, { evidenceId: ev.id, singletonKey: `tier:${ev.id}` });
    await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_TIER_CHANGE_REQUESTED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { from: cur.storage_tier, to: req.body.targetTier, queued: res.queued } });
    return reply.status(202).send({ queued: res.queued, alreadyQueued: !res.queued, jobId: res.jobId });
  });

  // ---------------------------------------------------------------- disposal (separation of duties)
  app.get('/disposal-candidates', {
    schema: { tags: ['evidence-lifecycle'], summary: 'Evidence past its retention date (no legal hold, no open case, no open request). Never auto-disposed.', querystring: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!hasPermission(p, 'retention:manage') && !hasPermission(p, 'evidence:dispose_request')) throw forbidden();
    const { page, pageSize } = req.query;
    const rows = await app.db
      .selectFrom('evidence as e')
      .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
      .leftJoin('retention_policies as rp', 'rp.id', 'e.retention_policy_id')
      .select(['e.id', 'e.evidence_number', 'e.title', 'e.retain_until', 'e.registered_at', 'e.size_bytes', 'e.storage_tier', 'o.id as org_id', 'o.name as org_name', 'rp.name as rp_name', sql<number>`count(*) OVER ()`.as('total')])
      .where(evidenceVisibleSql(p, 'e'))
      .where('e.status', '=', 'REGISTERED')
      .where('e.legal_hold', '=', false)
      .where('e.retain_until', '<', new Date())
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id WHERE ce.evidence_id = e.id AND ce.unlinked_at IS NULL AND c.status NOT IN ('CLOSED','ARCHIVED'))`)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM disposal_requests dr WHERE dr.evidence_id = e.id AND dr.status IN ('PENDING','APPROVED'))`)
      .orderBy('e.retain_until')
      .orderBy('e.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => ({ id: r.id, evidenceNumber: r.evidence_number, title: r.title, retainUntil: r.retain_until, registeredAt: r.registered_at, sizeBytes: r.size_bytes, storageTier: r.storage_tier, orgUnit: { id: r.org_id, name: r.org_name }, retentionPolicy: r.rp_name })),
      total: Number(rows[0]?.total ?? 0),
      page,
      pageSize,
    };
  });

  app.get('/disposal-requests', {
    schema: {
      tags: ['evidence-lifecycle'],
      summary: 'Disposal requests on evidence visible to the caller',
      querystring: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'CANCELLED']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!hasPermission(p, 'evidence:dispose_request') && !hasPermission(p, 'evidence:dispose_approve')) throw forbidden();
    const { status, page, pageSize } = req.query;
    let q = disposalQuery(app.db).select(sql<number>`count(*) OVER ()`.as('total')).where(evidenceVisibleSql(p, 'e'));
    if (status) q = q.where('dr.status', '=', status);
    const rows = await q.orderBy('dr.created_at', 'desc').orderBy('dr.id').limit(pageSize).offset((page - 1) * pageSize).execute();
    return { items: rows.map((r) => disposalDto(r, p)), total: Number(rows[0]?.total ?? 0), page, pageSize };
  });

  app.post('/:id/disposal-requests', {
    schema: {
      tags: ['evidence-lifecycle'], summary: 'Request authorised disposal (requires a different approver; before the end of retention only with a court / government order)', params: idParams,
      body: z.object({
        reason: z.string().trim().min(10).max(4000), authorityRef: z.string().trim().min(1).max(300),
        authorityType: z.enum(['COURT_ORDER', 'GOVERNMENT_ORDER']).optional(), authorityDate: z.coerce.date().optional(),
      }).strict(),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:dispose_request', req.actor());
    const created = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('evidence').select(['status', 'legal_hold', 'retain_until']).where('id', '=', ev.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.status !== 'REGISTERED') throw conflict(cur.status === 'DISPOSAL_PENDING' ? 'A disposal request is already open for this evidence' : `Evidence in status ${cur.status} cannot be disposed`);
      if (cur.legal_hold) throw conflict('Evidence is under legal hold and cannot be disposed');
      const open = await openCaseLinks(tx, ev.id);
      if (open.length) throw conflict(`Evidence is linked to open case(s): ${open.map((c) => c.case_number).join(', ')}`);
      // Before the end of retention (or with indefinite retention) only a court or government order authorises disposal.
      const early = !cur.retain_until || cur.retain_until > new Date();
      if (early && (!req.body.authorityType || !req.body.authorityDate)) {
        throw new AppError(409, 'RETENTION_NOT_ENDED', `Retention ${cur.retain_until ? `runs until ${cur.retain_until.toISOString().slice(0, 10)}` : 'is indefinite'}: disposal before then needs a court or government order — give its type, reference and date`, { retainUntil: cur.retain_until?.toISOString() ?? null });
      }
      if (req.body.authorityDate && req.body.authorityDate > new Date()) throw validationFailed('authorityDate cannot be in the future');
      const row = await tx.insertInto('disposal_requests').values({
        evidence_id: ev.id, requested_by: p.userId!, reason: req.body.reason, authority_ref: req.body.authorityRef,
        early, retain_until_at_request: cur.retain_until, authority_type: early ? req.body.authorityType! : (req.body.authorityType ?? 'RETENTION_EXPIRED'), authority_date: req.body.authorityDate ?? null,
      }).returning('id').executeTakeFirstOrThrow();
      await tx.updateTable('evidence').set({ status: 'DISPOSAL_PENDING', status_reason: 'Disposal requested' }).where('id', '=', ev.id).execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_DISPOSAL_REQUESTED', resourceType: 'disposal_request', resourceId: row.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason: req.body.reason, authorityRef: req.body.authorityRef, authorityType: req.body.authorityType ?? null, authorityDate: req.body.authorityDate?.toISOString().slice(0, 10) ?? null, early, retainUntil: cur.retain_until?.toISOString() ?? null } });
      return row;
    });
    const row = await disposalQuery(app.db).where('dr.id', '=', created.id).executeTakeFirstOrThrow();
    return reply.status(201).send(disposalDto(row, p));
  });

  /** Load a disposal request whose evidence the caller may act on with `perm` (404 if not visible). */
  async function loadRequest(p: Principal, requestId: string, perm: 'evidence:dispose_approve' | 'evidence:dispose_request', actor: AuditActor) {
    const r = await app.db.selectFrom('disposal_requests').select(['id', 'evidence_id']).where('id', '=', requestId).executeTakeFirst();
    if (!r) throw notFound('Disposal request');
    try {
      const ev = await loadEvidenceFor(app.db, p, r.evidence_id, perm, actor);
      return { requestId: r.id, ev };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) throw notFound('Disposal request');
      throw err;
    }
  }

  const decisionBody = z.object({ note: z.string().trim().min(3).max(4000), confirmEarly: z.boolean().optional() }).strict();

  app.post('/disposal-requests/:requestId/approve', { schema: { tags: ['evidence-lifecycle'], summary: 'Approve a disposal request (approver must differ from requester; blocked by legal hold)', params: reqParams, body: decisionBody } }, async (req) => {
    const p = req.requirePrincipal();
    const { requestId, ev } = await loadRequest(p, req.params.requestId, 'evidence:dispose_approve', req.actor());
    await app.db.transaction().execute(async (tx) => {
      const dr = await tx.selectFrom('disposal_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
      if (dr.status !== 'PENDING') throw conflict(`Request is ${dr.status.toLowerCase()}`);
      if (dr.requested_by === p.userId) throw forbidden('Separation of duties: you cannot approve your own disposal request');
      if (dr.early && req.body.confirmEarly !== true) throw new AppError(409, 'EARLY_DISPOSAL_CONFIRMATION_REQUIRED', 'This disposal is before the end of the retention period: confirm that the court / government order has been checked (confirmEarly)');
      const cur = await tx.selectFrom('evidence').select(['legal_hold', 'status']).where('id', '=', ev.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.legal_hold) throw conflict('Evidence is under legal hold; release the hold before approving disposal');
      const open = await openCaseLinks(tx, ev.id);
      if (open.length) throw conflict(`Evidence is linked to open case(s): ${open.map((c) => c.case_number).join(', ')}`);
      await tx.updateTable('disposal_requests').set({ status: 'APPROVED', decided_by: p.userId, decided_at: new Date(), decision_note: req.body.note }).where('id', '=', requestId).execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_DISPOSAL_APPROVED', resourceType: 'disposal_request', resourceId: requestId, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { note: req.body.note, early: dr.early, ...(dr.early ? { confirmedEarly: true, authorityType: dr.authority_type, authorityRef: dr.authority_ref } : {}) } });
    });
    const payload: DisposalExecutePayload = { disposalRequestId: requestId };
    const job = await queueJob(app.db, QUEUES.DISPOSAL_EXECUTE, 'DISPOSE', payload, { evidenceId: ev.id, singletonKey: `dispose:${requestId}` });
    const row = await disposalQuery(app.db).where('dr.id', '=', requestId).executeTakeFirstOrThrow();
    return { ...disposalDto(row, p), jobId: job.jobId };
  });

  app.post('/disposal-requests/:requestId/reject', { schema: { tags: ['evidence-lifecycle'], summary: 'Reject a disposal request', params: reqParams, body: decisionBody } }, async (req) => {
    const p = req.requirePrincipal();
    const { requestId, ev } = await loadRequest(p, req.params.requestId, 'evidence:dispose_approve', req.actor());
    await app.db.transaction().execute(async (tx) => {
      const dr = await tx.selectFrom('disposal_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
      if (dr.status !== 'PENDING') throw conflict(`Request is ${dr.status.toLowerCase()}`);
      if (dr.requested_by === p.userId) throw forbidden('Separation of duties: you cannot decide your own disposal request');
      await tx.updateTable('disposal_requests').set({ status: 'REJECTED', decided_by: p.userId, decided_at: new Date(), decision_note: req.body.note }).where('id', '=', requestId).execute();
      await tx.updateTable('evidence').set({ status: 'REGISTERED', status_reason: null }).where('id', '=', ev.id).where('status', '=', 'DISPOSAL_PENDING').execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_DISPOSAL_REJECTED', resourceType: 'disposal_request', resourceId: requestId, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { note: req.body.note } });
    });
    const row = await disposalQuery(app.db).where('dr.id', '=', requestId).executeTakeFirstOrThrow();
    return disposalDto(row, p);
  });

  app.post('/disposal-requests/:requestId/cancel', { schema: { tags: ['evidence-lifecycle'], summary: 'Cancel your own pending disposal request', params: reqParams, body: z.object({ note: z.string().trim().max(4000).optional() }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const { requestId, ev } = await loadRequest(p, req.params.requestId, 'evidence:dispose_request', req.actor());
    await app.db.transaction().execute(async (tx) => {
      const dr = await tx.selectFrom('disposal_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
      if (dr.requested_by !== p.userId) throw forbidden('Only the requester can cancel a disposal request');
      if (dr.status !== 'PENDING') throw conflict(`Request is ${dr.status.toLowerCase()}`);
      await tx.updateTable('disposal_requests').set({ status: 'CANCELLED', decision_note: req.body.note ?? null }).where('id', '=', requestId).execute();
      await tx.updateTable('evidence').set({ status: 'REGISTERED', status_reason: null }).where('id', '=', ev.id).where('status', '=', 'DISPOSAL_PENDING').execute();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_DISPOSAL_CANCELLED', resourceType: 'disposal_request', resourceId: requestId, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { note: req.body.note ?? null } });
    });
    const row = await disposalQuery(app.db).where('dr.id', '=', requestId).executeTakeFirstOrThrow();
    return disposalDto(row, p);
  });

  app.post('/disposal-requests/:requestId/retry', { schema: { tags: ['evidence-lifecycle'], summary: 'Re-queue execution of an approved disposal whose previous attempt failed', params: reqParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const { requestId, ev } = await loadRequest(p, req.params.requestId, 'evidence:dispose_approve', req.actor());
    const dr = await app.db.selectFrom('disposal_requests').select(['status']).where('id', '=', requestId).executeTakeFirstOrThrow();
    if (dr.status !== 'APPROVED') throw conflict(`Request is ${dr.status.toLowerCase()}`);
    const job = await queueJob(app.db, QUEUES.DISPOSAL_EXECUTE, 'DISPOSE', { disposalRequestId: requestId } satisfies DisposalExecutePayload, { evidenceId: ev.id, singletonKey: `dispose:${requestId}` });
    return reply.status(202).send({ queued: job.queued, jobId: job.jobId });
  });
}
