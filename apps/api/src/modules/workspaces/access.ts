/**
 * Workspace access rules (docs/INVESTIGATION.md):
 *  - a workspace is visible ONLY to its members (OWNER / EDITOR / VIEWER); non-members get 404;
 *  - VIEWER reads; EDITOR adds/removes items, bookmarks, annotations, timeline events; OWNER manages members,
 *    case link and archive state;
 *  - membership NEVER grants evidence access: every evidence-bearing row is filtered with evidenceVisibleSql /
 *    loadEvidenceFor for the calling user; items the member cannot see are returned as "restricted".
 *  - ARCHIVED workspaces are read-only (only the owner can re-activate).
 */
import type { Database, Tx } from '@ksp/core';
import type { Principal } from '../../lib/principal.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';

export const WS_ROLES = ['VIEWER', 'EDITOR', 'OWNER'] as const;
export type WsRole = (typeof WS_ROLES)[number];
const rank = (r: string) => WS_ROLES.indexOf(r as WsRole);

export interface WorkspaceAccess {
  id: string;
  title: string;
  status: string;
  case_id: string | null;
  owner_id: string;
  org_unit_id: string;
  role: WsRole;
}

export function requireUser(p: Principal): string {
  if (!p.userId) throw forbidden('Investigation workspaces require a user account');
  return p.userId;
}

/** Load a workspace the caller is a member of (404 otherwise); 403 if their role is below `min`. */
export async function loadWorkspace(db: Database | Tx, p: Principal, id: string, min: WsRole = 'VIEWER', opts: { allowArchived?: boolean } = {}): Promise<WorkspaceAccess> {
  const uid = requireUser(p);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Workspace');
  const row = await db
    .selectFrom('workspaces as w')
    .innerJoin('workspace_members as m', (j) => j.onRef('m.workspace_id', '=', 'w.id').on('m.user_id', '=', uid))
    .select(['w.id', 'w.title', 'w.status', 'w.case_id', 'w.owner_id', 'w.org_unit_id', 'm.role'])
    .where('w.id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Workspace');
  if (rank(row.role) < rank(min)) throw forbidden(`This action requires the ${min.toLowerCase()} role in the workspace`);
  if (min !== 'VIEWER' && row.status === 'ARCHIVED' && !opts.allowArchived) throw conflict('Workspace is archived (read-only)');
  return { ...row, role: row.role as WsRole };
}

export const atLeast = (role: WsRole, min: WsRole) => rank(role) >= rank(min);
