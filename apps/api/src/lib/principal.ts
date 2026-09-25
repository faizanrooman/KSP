import type { Permission } from '@ksp/shared';

/** A role grant resolved for authorization: permissions apply to orgPath and all descendants. */
export interface Grant {
  roleCode: string;
  roleName: string;
  orgUnitId: string;
  orgUnitName: string;
  orgPath: string;
  permissions: ReadonlySet<Permission>;
}

export interface Principal {
  kind: 'USER' | 'API_CLIENT';
  /** users.id for USER; null for API_CLIENT */
  userId: string | null;
  /** api_clients.id for API_CLIENT */
  apiClientId?: string;
  displayName: string;
  username: string;
  sessionId: string | null;
  homeOrgUnitId: string;
  homeOrgPath: string;
  grants: Grant[];
  /** Union of all grant permissions (jurisdiction-independent check). */
  permissions: ReadonlySet<Permission>;
  mustChangePassword: boolean;
  mfaEnrollmentRequired: boolean;
  mfaVerified: boolean;
}

/** ltree ancestor-or-self test on dotted paths. */
export function pathCovers(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

export function hasPermission(p: Principal, perm: Permission): boolean {
  return p.permissions.has(perm);
}

/** True if the principal holds `perm` through a grant whose org unit covers `orgPath`. */
export function hasPermissionAt(p: Principal, perm: Permission, orgPath: string): boolean {
  return p.grants.some((g) => g.permissions.has(perm) && pathCovers(g.orgPath, orgPath));
}

/** Minimal set of org paths where `perm` is granted (descendants of other entries removed). */
export function scopePaths(p: Principal, perm: Permission): string[] {
  const paths = [...new Set(p.grants.filter((g) => g.permissions.has(perm)).map((g) => g.orgPath))].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const path of paths) if (!out.some((o) => pathCovers(o, path))) out.push(path);
  return out;
}
