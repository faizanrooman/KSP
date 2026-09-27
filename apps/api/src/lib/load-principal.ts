import { isPermission, type Permission } from '@ksp/shared';
import type { Database } from '@ksp/core';
import type { Grant, Principal } from './principal.js';
import { getSettings } from './settings.js';

interface CacheEntry {
  at: number;
  principal: Principal;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10_000;

/** Drop cached principals (call after role/permission/user-status changes). */
export function invalidatePrincipals(userId?: string): void {
  if (!userId) return cache.clear();
  for (const [k, v] of cache) if (v.principal.userId === userId) cache.delete(k);
}

export async function loadGrants(db: Database, userId: string): Promise<Grant[]> {
  const rows = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
    .select(['r.code', 'r.name', 'r.permissions', 'o.id as org_id', 'o.name as org_name', 'o.path'])
    .where('ur.user_id', '=', userId)
    .where('o.active', '=', true)
    .where((eb) => eb.or([eb('ur.expires_at', 'is', null), eb('ur.expires_at', '>', new Date())]))
    .execute();
  return rows.map((r) => ({
    roleCode: r.code,
    roleName: r.name,
    orgUnitId: r.org_id,
    orgUnitName: r.org_name,
    orgPath: r.path,
    permissions: new Set(r.permissions.filter(isPermission)),
  }));
}

export async function loadUserPrincipal(db: Database, userId: string, sessionId: string, mfaVerified: boolean): Promise<Principal | null> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.principal;
  const user = await db
    .selectFrom('users as u')
    .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
    .select(['u.id', 'u.username', 'u.full_name', 'u.status', 'u.locked_until', 'u.must_change_password', 'u.password_changed_at', 'u.mfa_enabled', 'o.id as org_id', 'o.path'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!user || user.status !== 'ACTIVE') return null;
  const settings = await getSettings(db);
  const grants = await loadGrants(db, userId);
  const permissions = new Set<Permission>();
  for (const g of grants) for (const p of g.permissions) permissions.add(p);
  const maxAge = settings.passwordPolicy.maxAgeDays;
  const expired = maxAge > 0 && !!user.password_changed_at && Date.now() - user.password_changed_at.getTime() > maxAge * 86_400_000;
  const mfaRequired = grants.some((g) => settings.sessionPolicy.requireMfaForRoles.includes(g.roleCode));
  const principal: Principal = {
    kind: 'USER',
    userId: user.id,
    username: user.username,
    displayName: user.full_name,
    sessionId,
    homeOrgUnitId: user.org_id,
    homeOrgPath: user.path,
    grants,
    permissions,
    mustChangePassword: user.must_change_password || expired,
    mfaEnrollmentRequired: mfaRequired && !user.mfa_enabled,
    mfaVerified,
  };
  cache.set(sessionId, { at: Date.now(), principal });
  return principal;
}

export async function loadApiClientPrincipal(db: Database, client: { id: string; client_id: string; name: string; scopes: string[]; org_unit_id: string }): Promise<Principal> {
  const org = await db.selectFrom('org_units').select(['id', 'name', 'path']).where('id', '=', client.org_unit_id).executeTakeFirstOrThrow();
  const permissions = new Set(client.scopes.filter(isPermission));
  return {
    kind: 'API_CLIENT',
    userId: null,
    apiClientId: client.id,
    username: client.client_id,
    displayName: client.name,
    sessionId: null,
    homeOrgUnitId: org.id,
    homeOrgPath: org.path,
    grants: [{ roleCode: 'API_CLIENT', roleName: 'API client', orgUnitId: org.id, orgUnitName: org.name, orgPath: org.path, permissions }],
    permissions,
    mustChangePassword: false,
    mfaEnrollmentRequired: false,
    mfaVerified: true,
  };
}
