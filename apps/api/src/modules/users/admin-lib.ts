/**
 * Shared rules for the administration modules (users, roles, org, devices, settings).
 * See docs/AUTHORIZATION.md §"Administration rules" for the rationale of every rule here.
 *
 *  - Scope: a user account is managed through a grant covering the account's HOME org unit.
 *  - Role grants: the grantor must hold roles:manage at the target org unit, AND either hold every permission
 *    of the role at that unit, or hold roles:manage at a ROOT org unit (state-level administrator).
 *  - Self-modification: nobody may change their own status, credentials, MFA, role assignments, or the
 *    permissions of a role they currently hold (prevents self-escalation and self-demotion).
 *  - Separation of duties: no single user may hold both sides of a SOD_CONFLICTS pair across ALL their roles.
 *  - Lock-out protection: at least one ACTIVE user must keep roles:manage at a root org unit.
 */
import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { sodViolations, type PasswordPolicy, type Permission } from '@ksp/shared';
import { appendAudit, type Database, type Tx } from '@ksp/core';
import { hasPermissionAt, scopePaths, type Principal } from '../../lib/principal.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';

export const uuidParam = z.object({ id: z.string().uuid() });
export const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
export const reasonField = z.string().trim().min(5, 'Reason must be at least 5 characters').max(1000);

/** Escape LIKE wildcards in user input. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** True when the principal holds `perm` through a grant at a root org unit (whole-state scope). */
export function hasRootPermission(p: Principal, perm: Permission): boolean {
  return p.grants.some((g) => g.permissions.has(perm) && !g.orgPath.includes('.'));
}

/** Union of org paths where ANY of the permissions is granted (minimal set). */
export function unionScope(p: Principal, perms: Permission[]): string[] {
  const paths = [...new Set(perms.flatMap((perm) => scopePaths(p, perm)))].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const x of paths) if (!out.some((o) => x === o || x.startsWith(`${o}.`))) out.push(x);
  return out;
}

/**
 * Refuse an administrative action for a security rule: writes ADMIN_ACTION_DENIED (outside any business
 * transaction so the record survives) and returns the error to throw.
 */
export async function adminDenied(
  db: Database,
  req: FastifyRequest,
  code: 'SELF_MODIFICATION' | 'PRIVILEGE_ESCALATION' | 'OUT_OF_SCOPE' | 'SOD_VIOLATION' | 'LAST_ADMINISTRATOR',
  message: string,
  details: Record<string, unknown> = {},
): Promise<AppError> {
  await appendAudit(db, req.actor(), {
    action: 'ADMIN_ACTION_DENIED',
    outcome: 'DENIED',
    resourceType: 'route',
    resourceId: `${req.method} ${req.routeOptions.url}`,
    details: { rule: code, ...details },
  });
  const status = code === 'SOD_VIOLATION' ? 422 : code === 'LAST_ADMINISTRATOR' ? 409 : 403;
  return new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------
export interface ScopedUser {
  id: string;
  username: string;
  status: string;
  home_org_unit_id: string;
  home_path: string;
}

const USER_VISIBILITY: Permission[] = ['users:read', 'users:manage', 'roles:manage'];

export function canSeeUserAt(p: Principal, path: string): boolean {
  return USER_VISIBILITY.some((perm) => hasPermissionAt(p, perm, path));
}

/**
 * Load a user account for an administrative operation. Not visible to the caller (home org outside all of
 * users:read/users:manage/roles:manage scopes) => 404. Visible but `need` not held at the home unit => 403.
 */
export async function loadScopedUser(db: Database | Tx, p: Principal, id: string, need: Permission | null): Promise<ScopedUser> {
  const u = await db
    .selectFrom('users as u')
    .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
    .select(['u.id', 'u.username', 'u.status', 'u.home_org_unit_id', 'o.path as home_path'])
    .where('u.id', '=', id)
    .executeTakeFirst();
  if (!u || !canSeeUserAt(p, u.home_path)) throw notFound('User');
  if (need && !hasPermissionAt(p, need, u.home_path)) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action for this user');
  return u;
}

export async function loadOrgUnit(db: Database | Tx, id: string) {
  const o = await db.selectFrom('org_units').select(['id', 'code', 'name', 'path', 'active', 'parent_id', 'unit_type']).where('id', '=', id).executeTakeFirst();
  if (!o) throw notFound('Org unit');
  return o;
}

/** Effective (unexpired) permissions held by a user across all roles, optionally excluding one assignment. */
export async function userEffectivePermissions(db: Database | Tx, userId: string, opts: { excludeAssignmentId?: string; excludeRoleId?: string } = {}): Promise<string[]> {
  let q = db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .select('r.permissions')
    .where('ur.user_id', '=', userId)
    .where((eb) => eb.or([eb('ur.expires_at', 'is', null), eb('ur.expires_at', '>', new Date())]));
  if (opts.excludeAssignmentId) q = q.where('ur.id', '<>', opts.excludeAssignmentId);
  if (opts.excludeRoleId) q = q.where('ur.role_id', '<>', opts.excludeRoleId);
  const rows = await q.execute();
  return [...new Set(rows.flatMap((r) => r.permissions))];
}

/** SoD across a user's roles: returns violation messages if the user would end up holding both sides of a pair. */
export async function userSodViolations(db: Database | Tx, userId: string, extra: readonly string[], opts: { excludeRoleId?: string } = {}): Promise<string[]> {
  const current = await userEffectivePermissions(db, userId, opts);
  return sodViolations([...current, ...extra]);
}

/**
 * The grantor rule. Throws (with an ADMIN_ACTION_DENIED audit record) unless `p` may grant `role` at `org`.
 * Returns silently when allowed.
 */
export async function assertMayGrant(
  db: Database,
  req: FastifyRequest,
  p: Principal,
  role: { id: string; code: string; permissions: string[] },
  org: { id: string; path: string; active: boolean },
  targetUserId: string | null,
): Promise<void> {
  if (targetUserId && p.userId === targetUserId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot change your own role assignments', { role: role.code });
  if (!hasPermissionAt(p, 'roles:manage', org.path)) {
    throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot grant roles at an org unit outside your jurisdiction', { role: role.code, orgUnitId: org.id, targetUserId });
  }
  if (!org.active) throw conflict('Roles cannot be granted at an inactive org unit');
  if (!hasRootPermission(p, 'roles:manage')) {
    const missing = role.permissions.filter((perm) => !hasPermissionAt(p, perm as Permission, org.path));
    if (missing.length) {
      throw await adminDenied(db, req, 'PRIVILEGE_ESCALATION', 'You cannot grant a role that carries permissions you do not hold yourself at that org unit', {
        role: role.code, orgUnitId: org.id, targetUserId, missing,
      });
    }
  }
  if (!targetUserId) return; // new account: the caller checks SoD across all initial roles
  const sod = await userSodViolations(db, targetUserId, role.permissions);
  if (sod.length) throw await adminDenied(db, req, 'SOD_VIOLATION', `Separation of duties: ${sod.join('; ')}`, { role: role.code, targetUserId, violations: sod });
}

/**
 * Lock-out protection, evaluated INSIDE the transaction after the change: at least one ACTIVE user must still
 * hold an unexpired role with roles:manage at a root org unit. Throws 409 (rolling the change back).
 */
export async function assertRootAdministratorRemains(tx: Tx): Promise<void> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(DISTINCT u.id)::int AS n
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      JOIN org_units o ON o.id = ur.org_unit_id
     WHERE u.status = 'ACTIVE' AND o.parent_id IS NULL AND o.active
       AND 'roles:manage' = ANY (r.permissions)
       AND (ur.expires_at IS NULL OR ur.expires_at > now())`.execute(tx);
  if ((rows[0]?.n ?? 0) < 1) {
    throw new AppError(409, 'LAST_ADMINISTRATOR', 'This change would leave no active state-level administrator able to manage roles');
  }
}

// ---------------------------------------------------------------------------------------------
// One-time passwords
// ---------------------------------------------------------------------------------------------
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+?';

/** Cryptographically random temporary password satisfying `policy` (at least 16 chars, all classes). */
export function generateTemporaryPassword(policy: PasswordPolicy): string {
  const length = Math.min(64, Math.max(16, policy.minLength));
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
