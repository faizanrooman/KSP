/**
 * First Information Reports (spec module 12): list/detail/create/update/status, and import from an external
 * CCTNS/FIR system through an integration adapter (UNVERIFIED unless the system is verified).
 * Jurisdiction: cases:read / cases:manage covering firs.org_path (the registering station).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, type Database } from '@ksp/core';
import { FIR_STATUSES, FIR_TRANSITIONS, firDisplayNumber, normaliseFirNumber } from '@ksp/shared';
import { hasPermissionAt, type Principal } from '../../lib/principal.js';
import { conflict, notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { caseVisibleSql, firVisibleSql } from '../cases/access.js';
import { cctnsAdapter, parseConfig } from '../../integrations/adapters.js';
import { firToRow } from '../../integrations/contract.js';
import { integrationApiError, loadSystem, recordSync } from '../../integrations/sync.js';
import { IntegrationError, toIntegrationError } from '../../integrations/types.js';

export const prefix = '/firs';

const idParams = z.object({ id: z.string().uuid() });
const SORTS = ['registered_at', 'fir_year', 'fir_number', 'created_at'] as const;
const sortValues = SORTS.flatMap((s) => [s, `-${s}`]) as [string, ...string[]];
const actSection = z.string().trim().min(1).max(60);

const firBody = z.object({
  firNumber: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9/_-]+$/, 'letters, digits, / _ - only'),
  firYear: z.number().int().min(1950).max(2200),
  orgUnitId: z.string().uuid(),
  registeredAt: z.coerce.date(),
  actsSections: z.array(actSection).max(50).default([]),
  complainant: z.string().trim().max(500).nullable().optional(),
  briefFacts: z.string().trim().max(20_000).nullable().optional(),
  placeOfOccurrence: z.string().trim().max(1000).nullable().optional(),
  occurredFrom: z.coerce.date().nullable().optional(),
  occurredTo: z.coerce.date().nullable().optional(),
}).strict();

const patchBody = firBody.omit({ firNumber: true, firYear: true, orgUnitId: true }).partial().strict();

export interface FirRowFull {
  id: string; fir_number: string; fir_year: number; org_unit_id: string; org_path: string; registered_at: Date; acts_sections: string[];
  complainant: string | null; brief_facts: string | null; place_of_occurrence: string | null; occurred_from: Date | null; occurred_to: Date | null;
  status: string; source: string; external_ref: string | null; created_at: Date; updated_at: Date; org_name: string; org_code: string;
}

export function firDto(r: FirRowFull) {
  return {
    id: r.id,
    firNumber: r.fir_number,
    firYear: r.fir_year,
    displayNumber: firDisplayNumber(r.fir_number, r.fir_year),
    orgUnit: { id: r.org_unit_id, name: r.org_name, code: r.org_code },
    registeredAt: r.registered_at,
    actsSections: r.acts_sections,
    complainant: r.complainant,
    briefFacts: r.brief_facts,
    placeOfOccurrence: r.place_of_occurrence,
    occurredFrom: r.occurred_from,
    occurredTo: r.occurred_to,
    status: r.status,
    source: r.source,
    externalRef: r.external_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const FIR_COLS = [
  'f.id', 'f.fir_number', 'f.fir_year', 'f.org_unit_id', 'f.org_path', 'f.registered_at', 'f.acts_sections', 'f.complainant', 'f.brief_facts',
  'f.place_of_occurrence', 'f.occurred_from', 'f.occurred_to', 'f.status', 'f.source', 'f.external_ref', 'f.created_at', 'f.updated_at',
  'o.name as org_name', 'o.code as org_code',
] as const;

export async function loadFirFor(db: Database, p: Principal, id: string): Promise<FirRowFull> {
  const r = await db.selectFrom('firs as f').innerJoin('org_units as o', 'o.id', 'f.org_unit_id').select(FIR_COLS).where('f.id', '=', id).where(firVisibleSql(p, 'f')).executeTakeFirst();
  if (!r) throw notFound('FIR');
  return r;
}

/** Station the caller may register FIRs/cases for (cases:manage covering it). Out of scope => 404. */
export async function manageableStation(db: Database, p: Principal, orgUnitId: string) {
  const o = await db.selectFrom('org_units').select(['id', 'code', 'path', 'name', 'unit_type', 'active']).where('id', '=', orgUnitId).executeTakeFirst();
  if (!o || !hasPermissionAt(p, 'cases:manage', o.path)) throw notFound('Org unit');
  if (!o.active) throw unprocessable('Org unit is inactive');
  return o;
}

function isUnique(e: unknown): boolean {
  return (e as { code?: string })?.code === '23505';
}

export default async function firs(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/', {
    preHandler: app.authorize('cases:read'),
    schema: {
      tags: ['cases'],
      summary: 'List FIRs within jurisdiction',
      querystring: z.object({
        q: z.string().trim().max(200).optional(),
        orgUnitId: z.string().uuid().optional(),
        year: z.coerce.number().int().min(1950).max(2200).optional(),
        status: z.enum(FIR_STATUSES).optional(),
        actSection: z.string().trim().max(60).optional(),
        source: z.enum(['MANUAL', 'CCTNS', 'FIR_SYSTEM']).optional(),
        sort: z.enum(sortValues).default('-registered_at'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const f = req.query;
    let q = app.db.selectFrom('firs as f').innerJoin('org_units as o', 'o.id', 'f.org_unit_id').where(firVisibleSql(p, 'f'));
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      q = q.where(sql<boolean>`(f.fir_number ILIKE ${like} OR f.complainant ILIKE ${like} OR f.brief_facts ILIKE ${like} OR f.external_ref ILIKE ${like}
        OR (f.fir_number || '/' || f.fir_year) ILIKE ${like})`);
    }
    if (f.orgUnitId) q = q.where(sql<boolean>`f.org_path <@ (SELECT path FROM org_units WHERE id = ${f.orgUnitId}::uuid)`);
    if (f.year) q = q.where('f.fir_year', '=', f.year);
    if (f.status) q = q.where('f.status', '=', f.status);
    if (f.source) q = q.where('f.source', '=', f.source);
    if (f.actSection) {
      const like = `%${f.actSection.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM unnest(f.acts_sections) s WHERE s ILIKE ${like})`);
    }
    const desc = f.sort.startsWith('-');
    const key = desc ? f.sort.slice(1) : f.sort;
    const rows = await q
      .select(FIR_COLS)
      .select([
        sql<number>`count(*) OVER ()`.as('total'),
        sql<number>`(SELECT count(*)::int FROM cases c WHERE c.fir_id = f.id AND ${caseVisibleSql(p, 'c')})`.as('case_count'),
      ])
      .orderBy(sql`${sql.ref(`f.${key}`)} ${sql.raw(desc ? 'DESC' : 'ASC')}`)
      .orderBy('f.id')
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize)
      .execute();
    let total = Number(rows[0]?.total ?? 0);
    if (!rows.length && f.page > 1) total = Number((await q.select(sql<number>`count(*)`.as('n')).executeTakeFirst())?.n ?? 0);
    return { items: rows.map((r) => ({ ...firDto(r), caseCount: Number(r.case_count) })), total, page: f.page, pageSize: f.pageSize };
  });

  app.get('/:id', { preHandler: app.authorize('cases:read'), schema: { tags: ['cases'], summary: 'FIR detail with linked cases', params: idParams } }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadFirFor(app.db, p, req.params.id);
    const cases = await app.db
      .selectFrom('cases as c')
      .select(['c.id', 'c.case_number', 'c.title', 'c.status', 'c.priority'])
      .where('c.fir_id', '=', r.id)
      .where(caseVisibleSql(p, 'c'))
      .orderBy('c.opened_at')
      .execute();
    return {
      ...firDto(r),
      cases: cases.map((c) => ({ id: c.id, caseNumber: c.case_number, title: c.title, status: c.status, priority: c.priority })),
      permissions: { canManage: hasPermissionAt(p, 'cases:manage', r.org_path) },
      allowedTransitions: FIR_TRANSITIONS[r.status] ?? [],
    };
  });

  app.post('/', { preHandler: app.authorize('cases:manage'), schema: { tags: ['cases'], summary: 'Register a FIR manually', body: firBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    // The year is its own field: "0412/2026" typed as the number is stored as "0412" (shown as 0412/2026).
    const b = { ...req.body, firNumber: normaliseFirNumber(req.body.firNumber, req.body.firYear) };
    const org = await manageableStation(app.db, p, b.orgUnitId);
    if (b.occurredFrom && b.occurredTo && b.occurredTo < b.occurredFrom) throw validationFailed('occurredTo must not be before occurredFrom');
    // Records from before the normalisation may hold the number with its year ("0412/2026"): the same FIR.
    const dup = await app.db.selectFrom('firs').select('id').where('org_unit_id', '=', org.id).where('fir_year', '=', b.firYear)
      .where('fir_number', 'in', [b.firNumber, `${b.firNumber}/${b.firYear}`]).executeTakeFirst();
    if (dup) throw conflict(`FIR ${firDisplayNumber(b.firNumber, b.firYear)} is already registered for this station`);
    try {
      const id = await app.db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('firs')
          .values({
            fir_number: b.firNumber, fir_year: b.firYear, org_unit_id: org.id, org_path: org.path, registered_at: b.registeredAt,
            acts_sections: b.actsSections, complainant: b.complainant ?? null, brief_facts: b.briefFacts ?? null,
            place_of_occurrence: b.placeOfOccurrence ?? null, occurred_from: b.occurredFrom ?? null, occurred_to: b.occurredTo ?? null,
            source: 'MANUAL', created_by: p.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'FIR_CREATED', resourceType: 'fir', resourceId: row.id, orgUnitId: org.id, details: { firNumber: b.firNumber, firYear: b.firYear, source: 'MANUAL' } });
        return row.id;
      });
      reply.status(201);
      return firDto(await loadFirFor(app.db, p, id));
    } catch (e) {
      if (isUnique(e)) throw conflict(`FIR ${firDisplayNumber(b.firNumber, b.firYear)} is already registered for this station`);
      throw e;
    }
  });

  app.patch('/:id', { preHandler: app.authorize('cases:manage'), schema: { tags: ['cases'], summary: 'Edit FIR details', params: idParams, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadFirFor(app.db, p, req.params.id);
    if (!hasPermissionAt(p, 'cases:manage', r.org_path)) throw notFound('FIR');
    const b = req.body;
    const set: Record<string, unknown> = {};
    const map = { registeredAt: 'registered_at', actsSections: 'acts_sections', complainant: 'complainant', briefFacts: 'brief_facts', placeOfOccurrence: 'place_of_occurrence', occurredFrom: 'occurred_from', occurredTo: 'occurred_to' } as const;
    for (const [k, col] of Object.entries(map)) if (k in b) set[col] = (b as Record<string, unknown>)[k] ?? null;
    if (!Object.keys(set).length) throw validationFailed('No changes supplied');
    const from = (set.occurred_from as Date | null | undefined) ?? r.occurred_from;
    const to = (set.occurred_to as Date | null | undefined) ?? r.occurred_to;
    if (from && to && to < from) throw validationFailed('occurredTo must not be before occurredFrom');
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('firs').set(set).where('id', '=', r.id).execute();
      await appendAudit(tx, req.actor(), { action: 'FIR_UPDATED', resourceType: 'fir', resourceId: r.id, orgUnitId: r.org_unit_id, details: { fields: Object.keys(b) } });
    });
    return firDto(await loadFirFor(app.db, p, r.id));
  });

  app.post('/:id/status', {
    preHandler: app.authorize('cases:manage'),
    schema: { tags: ['cases'], summary: 'Change FIR status', params: idParams, body: z.object({ status: z.enum(FIR_STATUSES), reason: z.string().trim().min(5).max(2000) }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadFirFor(app.db, p, req.params.id);
    if (!hasPermissionAt(p, 'cases:manage', r.org_path)) throw notFound('FIR');
    const { status, reason } = req.body;
    if (!(FIR_TRANSITIONS[r.status] ?? []).includes(status)) throw conflict(`FIR status cannot change from ${r.status} to ${status}`, { allowed: FIR_TRANSITIONS[r.status] ?? [] });
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('firs').set({ status }).where('id', '=', r.id).where('status', '=', r.status).execute();
      await appendAudit(tx, req.actor(), { action: 'FIR_UPDATED', resourceType: 'fir', resourceId: r.id, orgUnitId: r.org_unit_id, details: { statusFrom: r.status, statusTo: status, reason } });
    });
    return firDto(await loadFirFor(app.db, p, r.id));
  });

  // ------------------------------------------------------------------------------------------ import
  app.post('/import', {
    preHandler: app.authorize('cases:manage'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['cases', 'integrations'],
      summary: 'Import (create or refresh) a FIR from an external CCTNS/FIR system via its adapter',
      body: z.object({
        systemId: z.string().uuid(),
        stationCode: z.string().trim().min(1).max(40),
        year: z.number().int().min(1950).max(2200),
        firNumber: z.string().trim().min(1).max(40),
      }).strict(),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = { ...req.body, firNumber: normaliseFirNumber(req.body.firNumber, req.body.year) };
    const sys = await loadSystem(app.db, b.systemId);
    if (sys.system_type !== 'CCTNS' && sys.system_type !== 'FIR') throw unprocessable('Selected system is not a CCTNS/FIR system');
    if (!sys.enabled) throw unprocessable('Integration system is disabled');
    const cfg = parseConfig(sys.config);
    const orgCode = cfg.stationCodeMap[b.stationCode] ?? b.stationCode.toLowerCase();
    const org = await app.db.selectFrom('org_units').select(['id', 'path', 'code', 'active']).where('code', '=', orgCode).executeTakeFirst();
    if (!org || !hasPermissionAt(p, 'cases:manage', org.path)) throw notFound('Station');
    const requestRef = `${b.stationCode}/${b.year}/${b.firNumber}`;
    const log = (status: 'SUCCESS' | 'FAILURE', summary: Record<string, unknown>, error?: string) =>
      recordSync(app.db, { systemId: sys.id, direction: 'INBOUND', operation: 'FIR_IMPORT', status, requestRef, summary: { ...summary, verified: sys.verified, adapter: sys.adapter }, error, userId: p.userId });
    let rec;
    try {
      rec = await cctnsAdapter(sys).fetchFir(b.stationCode, b.year, b.firNumber);
    } catch (e) {
      const ie = toIntegrationError(e);
      await log('FAILURE', { errorCode: ie.code }, ie.message);
      await appendAudit(app.db, req.actor(), { action: 'INTEGRATION_SYNC', outcome: 'FAILURE', resourceType: 'integration_system', resourceId: sys.id, orgUnitId: org.id, details: { operation: 'FIR_IMPORT', requestRef, errorCode: ie.code } });
      throw integrationApiError(ie);
    }
    if (!rec) {
      await log('FAILURE', { errorCode: 'NOT_FOUND' }, 'FIR not found upstream');
      await appendAudit(app.db, req.actor(), { action: 'INTEGRATION_SYNC', outcome: 'FAILURE', resourceType: 'integration_system', resourceId: sys.id, orgUnitId: org.id, details: { operation: 'FIR_IMPORT', requestRef, errorCode: 'NOT_FOUND' } });
      throw integrationApiError(new IntegrationError('NOT_FOUND', 'FIR not found in the external system'));
    }
    if (rec.stationCode !== b.stationCode || rec.firYear !== b.year) {
      const msg = 'Upstream returned a FIR for a different station/year than requested';
      await log('FAILURE', { errorCode: 'CONTRACT_MISMATCH' }, msg);
      throw integrationApiError(new IntegrationError('CONTRACT_MISMATCH', msg));
    }
    const source = sys.system_type === 'CCTNS' ? 'CCTNS' : 'FIR_SYSTEM';
    const row = firToRow(rec);
    const { id, created } = await app.db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('firs').select(['id', 'source']).where('org_unit_id', '=', org.id).where('fir_year', '=', row.fir_year).where('fir_number', '=', row.fir_number).forUpdate().executeTakeFirst();
      let firId: string;
      if (existing) {
        await tx.updateTable('firs').set({ ...row, source }).where('id', '=', existing.id).execute();
        firId = existing.id;
      } else {
        firId = (await tx.insertInto('firs').values({ ...row, org_unit_id: org.id, org_path: org.path, source, created_by: p.userId }).returning('id').executeTakeFirstOrThrow()).id;
      }
      await appendAudit(tx, req.actor(), {
        action: 'INTEGRATION_SYNC', resourceType: 'fir', resourceId: firId, orgUnitId: org.id,
        details: { operation: 'FIR_IMPORT', systemId: sys.id, systemCode: sys.code, requestRef, externalRef: rec.externalRef, created: !existing, systemVerified: sys.verified },
      });
      await appendAudit(tx, req.actor(), { action: existing ? 'FIR_UPDATED' : 'FIR_CREATED', resourceType: 'fir', resourceId: firId, orgUnitId: org.id, details: { source, externalRef: rec.externalRef, via: 'import' } });
      return { id: firId, created: !existing };
    });
    await log('SUCCESS', { firId: id, created, externalRef: rec.externalRef });
    reply.status(created ? 201 : 200);
    return { fir: firDto(await loadFirFor(app.db, p, id)), created, systemVerified: sys.verified, adapter: sys.adapter };
  });
}
