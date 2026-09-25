/**
 * Canonical evidence access rules (see docs/AUTHORIZATION.md). EVERY query that returns evidence (lists,
 * search, workspaces, cases, exports, dashboards) must apply `evidenceVisibleSql`, and every single-item
 * operation must go through `loadEvidenceFor`.
 *
 * An evidence item is VISIBLE to a user when ANY of:
 *   1. the user holds evidence:read through a grant covering evidence.org_path (jurisdiction);
 *   2. the user holds evidence:read_own and uploaded or recorded it;
 *   3. the user holds cases:read and is IO / supervisor / member of an active case the evidence is linked to;
 *   4. an ACTIVE, unexpired internal share targets the user.
 * An ACTION (play, download, snapshot, ...) additionally requires that permission — either through a grant
 * covering evidence.org_path, or (for relationship-based visibility 2–4) held anywhere by the user.
 * Downloads via shares additionally require share.allow_download.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Permission } from '@ksp/shared';
import { appendAudit, type Database, type Tx } from '@ksp/core';
import { hasPermission, hasPermissionAt, scopePaths, type Principal } from './principal.js';
import { forbidden, notFound } from './errors.js';
import type { AuditActor } from '@ksp/core';

export function evidenceVisibleSql(p: Principal, alias = 'evidence', opts: { jurisdiction?: boolean } = {}): RawBuilder<boolean> {
  const e = sql.raw(`"${alias.replace(/"/g, '')}"`);
  const readPaths = opts.jurisdiction === false ? [] : scopePaths(p, 'evidence:read');
  const parts: RawBuilder<unknown>[] = [];
  if (readPaths.length) parts.push(sql`${e}.org_path <@ ${sql.val(readPaths)}::ltree[]`);
  if (p.userId) {
    const uid = p.userId;
    if (hasPermission(p, 'evidence:read_own')) parts.push(sql`(${e}.uploaded_by = ${uid}::uuid OR ${e}.officer_id = ${uid}::uuid)`);
    if (hasPermission(p, 'cases:read')) {
      parts.push(sql`EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id
        WHERE ce.evidence_id = ${e}.id AND ce.unlinked_at IS NULL AND c.status <> 'ARCHIVED'
          AND (c.investigating_officer_id = ${uid}::uuid OR c.supervisor_id = ${uid}::uuid
               OR EXISTS (SELECT 1 FROM case_members cm WHERE cm.case_id = c.id AND cm.user_id = ${uid}::uuid)))`);
    }
    parts.push(sql`EXISTS (SELECT 1 FROM share_items si JOIN shares s ON s.id = si.share_id
      WHERE si.evidence_id = ${e}.id AND s.recipient_user_id = ${uid}::uuid AND s.status = 'ACTIVE' AND s.expires_at > now())`);
  }
  if (!parts.length) return sql<boolean>`false`;
  return sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}

export interface EvidenceAccessRow {
  id: string;
  org_path: string;
  org_unit_id: string;
  status: string;
  uploaded_by: string;
  officer_id: string | null;
  evidence_number: string | null;
}

/**
 * Load an evidence row the principal may see and act on. Not visible => 404 (no existence leak).
 * Visible but action not permitted => 403 and an EVIDENCE_ACCESS_DENIED custody event.
 */
export async function loadEvidenceFor(
  db: Database | Tx,
  p: Principal,
  evidenceId: string,
  action: Permission | null,
  actor: AuditActor,
): Promise<EvidenceAccessRow & { viaShareDownload: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) throw notFound('Evidence');
  const row = await db
    .selectFrom('evidence')
    .select(['id', 'org_path', 'org_unit_id', 'status', 'uploaded_by', 'officer_id', 'evidence_number'])
    .where('id', '=', evidenceId)
    .where(evidenceVisibleSql(p))
    .executeTakeFirst();
  if (!row) throw notFound('Evidence');
  let viaShareDownload = false;
  if (action && action !== 'evidence:read') {
    const scoped = hasPermissionAt(p, action, row.org_path);
    let allowed = scoped;
    if (!allowed && hasPermission(p, action) && action !== 'evidence:download_original') {
      // Relationship-based visibility (own/case/share): the permission may be held anywhere. Jurisdiction-only
      // visibility never borrows a permission granted for a different org unit.
      const rel = await db
        .selectFrom('evidence')
        .select('id')
        .where('id', '=', row.id)
        .where(evidenceVisibleSql(p, 'evidence', { jurisdiction: false }))
        .executeTakeFirst();
      allowed = !!rel;
    }
    if (!allowed && action === 'evidence:download_original' && p.userId) {
      const share = await db
        .selectFrom('share_items as si')
        .innerJoin('shares as s', 's.id', 'si.share_id')
        .select('s.id')
        .where('si.evidence_id', '=', row.id)
        .where('s.recipient_user_id', '=', p.userId)
        .where('s.status', '=', 'ACTIVE')
        .where('s.allow_download', '=', true)
        .where('s.expires_at', '>', new Date())
        .executeTakeFirst();
      allowed = !!share;
      viaShareDownload = allowed;
    }
    if (!allowed) {
      await appendAudit(db, actor, {
        action: 'EVIDENCE_ACCESS_DENIED',
        outcome: 'DENIED',
        resourceType: 'evidence',
        resourceId: row.id,
        evidenceId: row.id,
        orgUnitId: row.org_unit_id,
        details: { attemptedAction: action },
      });
      throw forbidden();
    }
  }
  return { ...row, viaShareDownload };
}

/** SQL filter restricting rows with an org_path column to the principal's scope for `perm`. */
export function orgScopeSql(p: Principal, perm: Permission, column = 'org_path'): RawBuilder<boolean> {
  const paths = scopePaths(p, perm);
  if (!paths.length) return sql<boolean>`false`;
  return sql<boolean>`${sql.ref(column)} <@ ${sql.val(paths)}::ltree[]`;
}
