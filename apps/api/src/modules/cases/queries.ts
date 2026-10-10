/** Case read models (camelCase DTOs) and validation helpers shared by the case routes. */
import { sql } from 'kysely';
import { firDisplayNumber, type Permission } from '@ksp/shared';
import type { Database, Tx } from '@ksp/core';
import { evidenceVisibleSql } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';
import { unprocessable } from '../../lib/errors.js';
import { caseVisibleSql } from './access.js';

export const CASE_SORTS = ['opened_at', 'updated_at', 'case_number', 'title', 'priority', 'status'] as const;

export interface CaseFilters {
  q?: string;
  status?: string[];
  priority?: string[];
  orgUnitId?: string;
  ioId?: string;
  supervisorId?: string;
  firId?: string;
  openedFrom?: Date;
  openedTo?: Date;
  mine?: boolean;
}

const PRIORITY_RANK = sql`CASE c.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END`;

function base(db: Database, p: Principal, f: CaseFilters) {
  let q = db
    .selectFrom('cases as c')
    .innerJoin('org_units as o', 'o.id', 'c.org_unit_id')
    .leftJoin('firs as f', 'f.id', 'c.fir_id')
    .leftJoin('users as io', 'io.id', 'c.investigating_officer_id')
    .leftJoin('users as sv', 'sv.id', 'c.supervisor_id')
    .where(caseVisibleSql(p, 'c'));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q = q.where(sql<boolean>`(c.title ILIKE ${like} OR c.case_number ILIKE ${like} OR c.court_case_number ILIKE ${like} OR c.external_ref ILIKE ${like}
      OR (f.fir_number || '/' || f.fir_year) ILIKE ${like})`);
  }
  if (f.status?.length) q = q.where('c.status', 'in', f.status);
  if (f.priority?.length) q = q.where('c.priority', 'in', f.priority);
  if (f.orgUnitId) q = q.where(sql<boolean>`c.org_path <@ (SELECT path FROM org_units WHERE id = ${f.orgUnitId}::uuid)`);
  if (f.ioId) q = q.where('c.investigating_officer_id', '=', f.ioId);
  if (f.supervisorId) q = q.where('c.supervisor_id', '=', f.supervisorId);
  if (f.firId) q = q.where('c.fir_id', '=', f.firId);
  if (f.openedFrom) q = q.where('c.opened_at', '>=', f.openedFrom);
  if (f.openedTo) q = q.where('c.opened_at', '<=', f.openedTo);
  if (f.mine && p.userId) {
    q = q.where(sql<boolean>`(c.investigating_officer_id = ${p.userId}::uuid OR c.supervisor_id = ${p.userId}::uuid
      OR EXISTS (SELECT 1 FROM case_members cm WHERE cm.case_id = c.id AND cm.user_id = ${p.userId}::uuid))`);
  }
  return q;
}

const person = (id: string | null, name: string | null, badge: string | null) => (id ? { id, fullName: name, badgeNumber: badge } : null);

export async function listCases(db: Database, p: Principal, f: CaseFilters, sort: string, page: number, pageSize: number) {
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const order = key === 'priority' ? PRIORITY_RANK : sql.ref(`c.${key}`);
  const rows = await base(db, p, f)
    .select([
      'c.id', 'c.case_number', 'c.title', 'c.status', 'c.priority', 'c.opened_at', 'c.closed_at', 'c.updated_at',
      'o.id as org_id', 'o.name as org_name', 'o.code as org_code',
      'f.id as fir_id', 'f.fir_number', 'f.fir_year',
      'io.id as io_id', 'io.full_name as io_name', 'io.badge_number as io_badge',
      'sv.id as sv_id', 'sv.full_name as sv_name', 'sv.badge_number as sv_badge',
      sql<number>`(SELECT count(*)::int FROM case_evidence ce WHERE ce.case_id = c.id AND ce.unlinked_at IS NULL)`.as('evidence_count'),
      sql<number>`count(*) OVER ()`.as('total'),
    ])
    .orderBy(sql`${order} ${sql.raw(desc ? 'DESC NULLS LAST' : 'ASC NULLS LAST')}`)
    .orderBy('c.id')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  let total = Number(rows[0]?.total ?? 0);
  if (!rows.length && page > 1) total = Number((await base(db, p, f).select(sql<number>`count(*)`.as('n')).executeTakeFirst())?.n ?? 0);
  return {
    items: rows.map((r) => ({
      id: r.id,
      caseNumber: r.case_number,
      title: r.title,
      status: r.status,
      priority: r.priority,
      orgUnit: { id: r.org_id, name: r.org_name, code: r.org_code },
      fir: r.fir_id ? { id: r.fir_id, firNumber: r.fir_number, firYear: r.fir_year, displayNumber: firDisplayNumber(r.fir_number ?? '', r.fir_year ?? 0) } : null,
      investigatingOfficer: person(r.io_id, r.io_name, r.io_badge),
      supervisor: person(r.sv_id, r.sv_name, r.sv_badge),
      evidenceCount: Number(r.evidence_count),
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      updatedAt: r.updated_at,
    })),
    total,
    page,
    pageSize,
  };
}

export async function caseDetail(db: Database, p: Principal, id: string) {
  const r = await db
    .selectFrom('cases as c')
    .innerJoin('org_units as o', 'o.id', 'c.org_unit_id')
    .leftJoin('firs as f', 'f.id', 'c.fir_id')
    .leftJoin('users as io', 'io.id', 'c.investigating_officer_id')
    .leftJoin('users as sv', 'sv.id', 'c.supervisor_id')
    .leftJoin('users as cb', 'cb.id', 'c.created_by')
    .select([
      'c.id', 'c.case_number', 'c.title', 'c.description', 'c.status', 'c.priority', 'c.org_unit_id', 'c.court_name', 'c.court_case_number',
      'c.opened_at', 'c.closed_at', 'c.external_system', 'c.external_ref', 'c.created_at', 'c.updated_at',
      'o.name as org_name', 'o.code as org_code',
      'f.id as fir_id', 'f.fir_number', 'f.fir_year', 'f.status as fir_status', 'f.acts_sections', 'f.registered_at as fir_registered_at', 'f.source as fir_source',
      'io.id as io_id', 'io.full_name as io_name', 'io.badge_number as io_badge',
      'sv.id as sv_id', 'sv.full_name as sv_name', 'sv.badge_number as sv_badge',
      'cb.id as cb_id', 'cb.full_name as cb_name',
    ])
    .where('c.id', '=', id)
    .executeTakeFirstOrThrow();
  const members = await db
    .selectFrom('case_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
    .leftJoin('users as ab', 'ab.id', 'm.added_by')
    .select(['u.id', 'u.full_name', 'u.username', 'u.badge_number', 'u.status', 'o.name as org_name', 'm.role', 'm.added_at', 'ab.full_name as added_by_name'])
    .where('m.case_id', '=', id)
    .orderBy('m.added_at')
    .execute();
  const counts = await db
    .selectFrom('case_evidence as ce')
    .innerJoin('evidence as e', 'e.id', 'ce.evidence_id')
    .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE ${evidenceVisibleSql(p, 'e')})::int`.as('visible')])
    .where('ce.case_id', '=', id)
    .where('ce.unlinked_at', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    id: r.id,
    caseNumber: r.case_number,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    orgUnitId: r.org_unit_id,
    orgUnit: { id: r.org_unit_id, name: r.org_name, code: r.org_code },
    fir: r.fir_id
      ? { id: r.fir_id, firNumber: r.fir_number, firYear: r.fir_year, displayNumber: firDisplayNumber(r.fir_number ?? '', r.fir_year ?? 0), status: r.fir_status, actsSections: r.acts_sections, registeredAt: r.fir_registered_at, source: r.fir_source }
      : null,
    investigatingOfficer: person(r.io_id, r.io_name, r.io_badge),
    supervisor: person(r.sv_id, r.sv_name, r.sv_badge),
    members: members.map((m) => ({ id: m.id, fullName: m.full_name, username: m.username, badgeNumber: m.badge_number, userStatus: m.status, orgUnitName: m.org_name, role: m.role, addedAt: m.added_at, addedByName: m.added_by_name })),
    court: { name: r.court_name, caseNumber: r.court_case_number },
    external: { system: r.external_system, ref: r.external_ref },
    evidenceCount: Number(counts.visible),
    hiddenEvidenceCount: Number(counts.total) - Number(counts.visible),
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    createdBy: r.cb_id ? { id: r.cb_id, fullName: r.cb_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function holdsPermission(db: Database | Tx, userId: string, perm: Permission): Promise<boolean> {
  const r = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
    .select('ur.user_id')
    .where('ur.user_id', '=', userId)
    .where('o.active', '=', true)
    .where(sql<boolean>`${perm} = ANY(r.permissions)`)
    .where((eb) => eb.or([eb('ur.expires_at', 'is', null), eb('ur.expires_at', '>', new Date())]))
    .executeTakeFirst();
  return !!r;
}

/**
 * IO / supervisor rule: ACTIVE user, home org unit within the case station's tree OR an ancestor of it
 * (e.g. a district-level supervisor), and holding `cases:read` (they must be able to use the case).
 * The IO must additionally hold cases:manage.
 */
export async function assertCaseOfficer(db: Database | Tx, userId: string, stationPath: string, role: 'IO' | 'SUPERVISOR'): Promise<void> {
  const label = role === 'IO' ? 'Investigating officer' : 'Supervisor';
  const u = await db
    .selectFrom('users as u')
    .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
    .select(['u.id', 'u.status', sql<boolean>`(o.path @> ${stationPath}::ltree OR o.path <@ ${stationPath}::ltree)`.as('in_tree')])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!u || u.status !== 'ACTIVE') throw unprocessable(`${label} must be an active user`);
  if (!u.in_tree) throw unprocessable(`${label} must belong to the case station or a unit above it`);
  if (!(await holdsPermission(db, userId, 'cases:read'))) throw unprocessable(`${label} must hold a role with case access`);
  if (role === 'IO' && !(await holdsPermission(db, userId, 'cases:manage'))) throw unprocessable('Investigating officer must hold a role that can manage cases');
}

/** Case members: ACTIVE users holding cases:read anywhere (cross-station team members are allowed). */
export async function assertMember(db: Database | Tx, userId: string): Promise<void> {
  const u = await db.selectFrom('users').select(['status']).where('id', '=', userId).executeTakeFirst();
  if (!u || u.status !== 'ACTIVE') throw unprocessable('Member must be an active user');
  if (!(await holdsPermission(db, userId, 'cases:read'))) throw unprocessable('Member must hold a role with case access (cases:read)');
}
