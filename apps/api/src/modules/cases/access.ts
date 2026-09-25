/**
 * Case & FIR access rules (see docs/CASES.md).
 *
 *  READ a case:   cases:read through a grant covering case.org_path, OR (holding cases:read anywhere) being the
 *                 case's IO, supervisor or a member ("case team").
 *  MANAGE a case (edit, status, team): cases:manage covering case.org_path, OR IO/supervisor holding cases:manage.
 *  LINK evidence: cases:link_evidence covering case.org_path, OR case team holding cases:link_evidence; and every
 *                 evidence item must pass loadEvidenceFor(..., 'evidence:read').
 *  DIARY notes:   anyone who may READ the case and is on the team or may MANAGE it.
 *  FIRs:          cases:read / cases:manage covering fir.org_path (plus FIRs of cases the user can read).
 * Out of scope => 404 (never 403).
 */
import { sql, type RawBuilder } from 'kysely';
import type { Permission } from '@ksp/shared';
import type { Database, Tx } from '@ksp/core';
import { orgScopeSql } from '../../lib/access.js';
import { hasPermission, hasPermissionAt, type Principal } from '../../lib/principal.js';
import { notFound } from '../../lib/errors.js';

/** SQL predicate: case row (alias) visible to principal. */
export function caseVisibleSql(p: Principal, alias = 'c'): RawBuilder<boolean> {
  const a = alias.replace(/[^a-z0-9_]/gi, '');
  const scope = orgScopeSql(p, 'cases:read', `${a}.org_path`);
  if (!p.userId || !hasPermission(p, 'cases:read')) return scope;
  const c = sql.raw(a);
  return sql<boolean>`(${scope} OR ${c}.investigating_officer_id = ${p.userId}::uuid OR ${c}.supervisor_id = ${p.userId}::uuid
    OR EXISTS (SELECT 1 FROM case_members cm WHERE cm.case_id = ${c}.id AND cm.user_id = ${p.userId}::uuid))`;
}

export interface CaseAccessRow {
  id: string;
  case_number: string;
  title: string;
  status: string;
  org_unit_id: string;
  org_path: string;
  fir_id: string | null;
  investigating_officer_id: string | null;
  supervisor_id: string | null;
  external_ref: string | null;
}

export interface CaseAccess {
  row: CaseAccessRow;
  onTeam: boolean;
  isMember: boolean;
  canManage: boolean;
  canLink: boolean;
  canAddNote: boolean;
}

export async function loadCaseFor(db: Database | Tx, p: Principal, caseId: string): Promise<CaseAccess> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw notFound('Case');
  const row = await db
    .selectFrom('cases as c')
    .select(['c.id', 'c.case_number', 'c.title', 'c.status', 'c.org_unit_id', 'c.org_path', 'c.fir_id', 'c.investigating_officer_id', 'c.supervisor_id', 'c.external_ref'])
    .where('c.id', '=', caseId)
    .where(caseVisibleSql(p, 'c'))
    .executeTakeFirst();
  if (!row) throw notFound('Case');
  return caseAccess(db, p, row);
}

export async function caseAccess(db: Database | Tx, p: Principal, row: CaseAccessRow): Promise<CaseAccess> {
  const uid = p.userId;
  const lead = !!uid && (row.investigating_officer_id === uid || row.supervisor_id === uid);
  const isMember = !!uid && !lead && !!(await db.selectFrom('case_members').select('user_id').where('case_id', '=', row.id).where('user_id', '=', uid).executeTakeFirst());
  const onTeam = lead || isMember;
  const at = (perm: Permission) => hasPermissionAt(p, perm, row.org_path);
  const canManage = at('cases:manage') || (lead && hasPermission(p, 'cases:manage'));
  const canLink = at('cases:link_evidence') || (onTeam && hasPermission(p, 'cases:link_evidence'));
  return { row, onTeam, isMember, canManage, canLink, canAddNote: onTeam || canManage };
}

export function firVisibleSql(p: Principal, alias = 'f'): RawBuilder<boolean> {
  const a = alias.replace(/[^a-z0-9_]/gi, '');
  const scope = orgScopeSql(p, 'cases:read', `${a}.org_path`);
  if (!p.userId || !hasPermission(p, 'cases:read')) return scope;
  // FIRs of cases where the user is on the team are readable too.
  return sql<boolean>`(${scope} OR EXISTS (SELECT 1 FROM cases c2 WHERE c2.fir_id = ${sql.raw(a)}.id AND ${caseVisibleSql(p, 'c2')}))`;
}
