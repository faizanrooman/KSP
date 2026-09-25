/**
 * Case management (spec module 12): cases, status workflow, team, evidence linking, case diary, timeline.
 * Access rules: ./access.ts and docs/CASES.md. Evidence rows always go through evidenceVisibleSql / loadEvidenceFor.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit } from '@ksp/core';
import { CASE_PRIORITIES, CASE_STATUSES, CASE_TRANSITIONS, caseTransitionNeedsReason } from '@ksp/shared';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { caseVisibleSql, firVisibleSql, loadCaseFor } from './access.js';
import { CASE_SORTS, assertCaseOfficer, caseDetail, listCases } from './queries.js';
import { manageableStation } from '../firs/index.js';
import linkRoutes from './links.js';

export const prefix = '/cases';

export const idParams = z.object({ id: z.string().uuid() });
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().optional().transform((v, ctx) => {
    if (!v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    for (const x of parts) if (!(values as readonly string[]).includes(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid value ${x}` });
    return parts;
  });
const sortValues = CASE_SORTS.flatMap((s) => [s, `-${s}`]) as [string, ...string[]];
const text = (max: number) => z.string().trim().max(max);

const createBody = z.object({
  title: z.string().trim().min(3).max(300),
  description: text(20_000).nullable().optional(),
  orgUnitId: z.string().uuid().optional(),
  firId: z.string().uuid().nullable().optional(),
  priority: z.enum(CASE_PRIORITIES).default('NORMAL'),
  investigatingOfficerId: z.string().uuid().nullable().optional(),
  supervisorId: z.string().uuid().nullable().optional(),
  courtName: text(300).nullable().optional(),
  courtCaseNumber: text(100).nullable().optional(),
  externalSystem: text(100).nullable().optional(),
  externalRef: text(200).nullable().optional(),
}).strict();

const patchBody = createBody.omit({ orgUnitId: true }).partial().strict();

function stationCode(code: string): string {
  return code.replace(/^ps_/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export default async function cases(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/', {
    preHandler: app.authorize('cases:read'),
    schema: {
      tags: ['cases'],
      summary: 'List cases visible to the caller (jurisdiction or case team)',
      querystring: z.object({
        q: z.string().trim().max(200).optional(),
        status: csv(CASE_STATUSES),
        priority: csv(CASE_PRIORITIES),
        orgUnitId: z.string().uuid().optional(),
        ioId: z.string().uuid().optional(),
        supervisorId: z.string().uuid().optional(),
        firId: z.string().uuid().optional(),
        openedFrom: z.coerce.date().optional(),
        openedTo: z.coerce.date().optional(),
        mine: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        sort: z.enum(sortValues).default('-opened_at'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const { sort, page, pageSize, ...f } = req.query;
    return listCases(app.db, req.requirePrincipal(), f, sort, page, pageSize);
  });

  app.get('/:id', { preHandler: app.authorize('cases:read'), schema: { tags: ['cases'], summary: 'Case detail', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    const body = await caseDetail(app.db, p, acc.row.id);
    return {
      ...body,
      permissions: { canManage: acc.canManage, canLinkEvidence: acc.canLink, canAddNote: acc.canAddNote, onTeam: acc.onTeam },
      allowedTransitions: CASE_TRANSITIONS[acc.row.status] ?? [],
    };
  });

  app.post('/', { preHandler: app.authorize('cases:manage'), schema: { tags: ['cases'], summary: 'Open a case (auto case number CASE-<STATION>-<YYYY>-<NNNN>)', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    let fir: { id: string; org_unit_id: string } | undefined;
    if (b.firId) {
      fir = await app.db.selectFrom('firs as f').select(['f.id', 'f.org_unit_id']).where('f.id', '=', b.firId).where(firVisibleSql(p, 'f')).executeTakeFirst();
      if (!fir) throw notFound('FIR');
    }
    const orgUnitId = b.orgUnitId ?? fir?.org_unit_id ?? p.homeOrgUnitId;
    const org = await manageableStation(app.db, p, orgUnitId);
    const ioId = b.investigatingOfficerId === undefined ? (p.userId && p.permissions.has('cases:manage') ? p.userId : null) : b.investigatingOfficerId;
    if (ioId) await assertCaseOfficer(app.db, ioId, org.path, 'IO');
    if (b.supervisorId) await assertCaseOfficer(app.db, b.supervisorId, org.path, 'SUPERVISOR');
    const year = new Date().getUTCFullYear();
    const id = await app.db.transaction().execute(async (tx) => {
      const c = await tx
        .insertInto('case_number_counters')
        .values({ org_unit_id: org.id, year, last_value: 1 })
        .onConflict((oc) => oc.columns(['org_unit_id', 'year']).doUpdateSet((eb) => ({ last_value: eb('case_number_counters.last_value', '+', 1) })))
        .returning('last_value')
        .executeTakeFirstOrThrow();
      const caseNumber = `CASE-${stationCode(org.code)}-${year}-${String(c.last_value).padStart(4, '0')}`;
      const row = await tx
        .insertInto('cases')
        .values({
          case_number: caseNumber, title: b.title, description: b.description ?? null, fir_id: fir?.id ?? null, org_unit_id: org.id, org_path: org.path,
          priority: b.priority, investigating_officer_id: ioId, supervisor_id: b.supervisorId ?? null, court_name: b.courtName ?? null,
          court_case_number: b.courtCaseNumber ?? null, external_system: b.externalSystem ?? null, external_ref: b.externalRef ?? null, created_by: p.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'CASE_CREATED', resourceType: 'case', resourceId: row.id, caseId: row.id, orgUnitId: org.id,
        details: { caseNumber, title: b.title, firId: fir?.id ?? null, investigatingOfficerId: ioId, supervisorId: b.supervisorId ?? null, priority: b.priority },
      });
      return row.id;
    });
    reply.status(201);
    return caseDetail(app.db, p, id);
  });

  app.patch('/:id', { preHandler: app.authorize('cases:manage'), schema: { tags: ['cases'], summary: 'Edit case details, IO/supervisor, FIR, court information', params: idParams, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canManage) throw notFound('Case');
    if (acc.row.status === 'ARCHIVED') throw conflict('Archived cases cannot be edited; reopen first');
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('No changes supplied');
    if (b.firId) {
      const fir = await app.db.selectFrom('firs as f').select('f.id').where('f.id', '=', b.firId).where(firVisibleSql(p, 'f')).executeTakeFirst();
      if (!fir) throw notFound('FIR');
    }
    if (b.investigatingOfficerId) await assertCaseOfficer(app.db, b.investigatingOfficerId, acc.row.org_path, 'IO');
    if (b.supervisorId) await assertCaseOfficer(app.db, b.supervisorId, acc.row.org_path, 'SUPERVISOR');
    const map = {
      title: 'title', description: 'description', firId: 'fir_id', priority: 'priority', investigatingOfficerId: 'investigating_officer_id', supervisorId: 'supervisor_id',
      courtName: 'court_name', courtCaseNumber: 'court_case_number', externalSystem: 'external_system', externalRef: 'external_ref',
    } as const;
    const set: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) if (k in b) set[col] = (b as Record<string, unknown>)[k] ?? null;
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('cases').set(set).where('id', '=', acc.row.id).execute();
      const changes: Record<string, unknown> = {};
      if ('investigatingOfficerId' in b) changes.investigatingOfficer = { from: acc.row.investigating_officer_id, to: b.investigatingOfficerId ?? null };
      if ('supervisorId' in b) changes.supervisor = { from: acc.row.supervisor_id, to: b.supervisorId ?? null };
      if ('firId' in b) changes.fir = { from: acc.row.fir_id, to: b.firId ?? null };
      await appendAudit(tx, req.actor(), { action: 'CASE_UPDATED', resourceType: 'case', resourceId: acc.row.id, caseId: acc.row.id, orgUnitId: acc.row.org_unit_id, details: { fields: Object.keys(b), ...changes } });
    });
    return caseDetail(app.db, p, acc.row.id);
  });

  app.post('/:id/status', {
    preHandler: app.authorize('cases:manage'),
    schema: { tags: ['cases'], summary: 'Change case status (validated workflow; close/archive/reopen need a reason)', params: idParams, body: z.object({ status: z.enum(CASE_STATUSES), reason: z.string().trim().max(2000).optional() }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canManage) throw notFound('Case');
    const from = acc.row.status;
    const { status: to, reason } = req.body;
    const allowed = CASE_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) throw conflict(`Case status cannot change from ${from} to ${to}`, { allowed });
    if (caseTransitionNeedsReason(from, to) && (!reason || reason.length < 5)) throw validationFailed('A reason (at least 5 characters) is required for this status change');
    const reopen = from === 'CLOSED' || from === 'ARCHIVED';
    await app.db.transaction().execute(async (tx) => {
      const res = await tx
        .updateTable('cases')
        .set({ status: to, ...(to === 'CLOSED' ? { closed_at: new Date() } : reopen && to !== 'ARCHIVED' ? { closed_at: null } : {}) })
        .where('id', '=', acc.row.id)
        .where('status', '=', from)
        .executeTakeFirst();
      if (!Number(res.numUpdatedRows)) throw conflict('Case status changed concurrently; reload and retry');
      await appendAudit(tx, req.actor(), {
        action: 'CASE_STATUS_CHANGED', resourceType: 'case', resourceId: acc.row.id, caseId: acc.row.id, orgUnitId: acc.row.org_unit_id,
        details: { from, to, reason: reason ?? null, reopen: reopen && to === 'UNDER_INVESTIGATION' },
      });
    });
    const body = await caseDetail(app.db, p, acc.row.id);
    return { ...body, allowedTransitions: CASE_TRANSITIONS[to] ?? [] };
  });

  // Small aggregate used by the case list header.
  app.get('/stats/summary', { preHandler: app.authorize('cases:read'), schema: { tags: ['cases'], summary: 'Case counts by status (visible cases)' } }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await app.db.selectFrom('cases as c').select(['c.status', sql<number>`count(*)::int`.as('n')]).where(caseVisibleSql(p, 'c')).groupBy('c.status').execute();
    return { byStatus: Object.fromEntries(CASE_STATUSES.map((s) => [s, Number(rows.find((r) => r.status === s)?.n ?? 0)])) };
  });

  await app.register(linkRoutes);
}
