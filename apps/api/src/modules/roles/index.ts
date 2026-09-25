/**
 * Role catalogue administration. Roles are GLOBAL definitions (a permission set); jurisdiction comes from the
 * org unit at which a role is granted (POST /users/:id/roles).
 *
 * Rules (docs/AUTHORIZATION.md):
 *  - roles:read to view, roles:manage to change;
 *  - unknown permission codes are rejected; no role may hold both sides of an SoD pair; a change that would
 *    give ANY current holder both sides of a pair across their roles is rejected;
 *  - system roles cannot be deleted; custom roles only when no assignment references them;
 *  - editing a system role, or a role assigned outside the editor's roles:manage scope, requires roles:manage at
 *    a root org unit; adding a permission requires the editor to hold it (unless roles:manage at root);
 *  - nobody may edit the permissions of a role they currently hold (no self-escalation / self-demotion);
 *  - at least one active state-level user must keep roles:manage.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { ALL_PERMISSIONS, PERMISSIONS, SOD_CONFLICTS, sodViolations, type Permission } from '@ksp/shared';
import { appendAudit, isUniqueViolation } from '@ksp/core';
import { hasPermission, scopePaths } from '../../lib/principal.js';
import { invalidatePrincipals } from '../../lib/load-principal.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { adminDenied, assertRootAdministratorRemains, hasRootPermission, userSodViolations, uuidParam } from '../users/admin-lib.js';

export const prefix = '/roles';

const permissionCode = z.string().refine((v): v is Permission => (ALL_PERMISSIONS as string[]).includes(v), { message: 'Unknown permission code' });
const permissionList = z.array(permissionCode).max(ALL_PERMISSIONS.length).transform((v) => [...new Set(v)].sort() as Permission[]);
const createBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,40}$/, 'Code: upper-case letters, digits and underscore (2-41 chars)'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  permissions: permissionList,
}).strict();
const patchBody = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).nullable(),
  permissions: permissionList,
}).partial().strict();

const CATEGORY_LABELS: Record<string, string> = {
  users: 'Users', roles: 'Roles', org: 'Organisation', devices: 'Devices', settings: 'Settings', integrations: 'Integrations',
  evidence: 'Evidence', retention: 'Retention', ai: 'AI analysis', search: 'Search', workspace: 'Investigation workspace',
  cases: 'Cases', custody: 'Chain of custody', audit: 'Audit', export: 'Court export', share: 'Sharing', dashboard: 'Dashboards',
  reports: 'Reports', alerts: 'Alerts', system: 'System',
};

export default async function roles(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const baseQuery = () =>
    db.selectFrom('roles as r')
      .select(['r.id', 'r.code', 'r.name', 'r.description', 'r.permissions', 'r.is_system', 'r.created_at', 'r.updated_at'])
      .select(sql<number>`(SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id AND (ur.expires_at IS NULL OR ur.expires_at > now()))`.as('active_assignments'))
      .select(sql<number>`(SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id)`.as('all_assignments'));
  type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['executeTakeFirstOrThrow']>>;
  const dto = (r: Row) => ({
    id: r.id, code: r.code, name: r.name, description: r.description, permissions: [...r.permissions].sort(), isSystem: r.is_system,
    assignmentCount: r.active_assignments, totalAssignmentCount: r.all_assignments, createdAt: r.created_at, updatedAt: r.updated_at,
    sodViolations: sodViolations(r.permissions),
  });

  app.get('/', { preHandler: app.authorize('roles:read'), schema: { tags: ['roles'], summary: 'All roles with permission sets and assignment counts' } }, async () => {
    const rows = await baseQuery().orderBy('r.is_system', 'desc').orderBy('r.name').execute();
    return { items: rows.map(dto) };
  });

  app.get('/permissions', { preHandler: app.authorize('roles:read'), schema: { tags: ['roles'], summary: 'Permission catalogue grouped by category, plus separation-of-duties constraints' } }, async () => {
    const groups = new Map<string, Array<{ code: string; description: string }>>();
    for (const code of ALL_PERMISSIONS) {
      const cat = code.split(':')[0]!;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push({ code, description: PERMISSIONS[code] });
    }
    return {
      groups: [...groups].map(([category, permissions]) => ({ category, label: CATEGORY_LABELS[category] ?? category, permissions })),
      sodConflicts: SOD_CONFLICTS.map(([a, b, message]) => ({ a, b, message })),
    };
  });

  app.get('/:id', { preHandler: app.authorize('roles:read'), schema: { tags: ['roles'], summary: 'Role detail', params: uuidParam } }, async (req) => {
    const r = await baseQuery().where('r.id', '=', req.params.id).executeTakeFirst();
    if (!r) throw notFound('Role');
    return dto(r);
  });

  app.post('/', { preHandler: app.authorize('roles:manage'), schema: { tags: ['roles'], summary: 'Create a custom role', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const sod = sodViolations(b.permissions);
    if (sod.length) throw await adminDenied(db, req, 'SOD_VIOLATION', `Separation of duties: ${sod.join('; ')}`, { role: b.code, violations: sod });
    if (!hasRootPermission(p, 'roles:manage')) {
      const missing = b.permissions.filter((perm) => !hasPermission(p, perm));
      if (missing.length) throw await adminDenied(db, req, 'PRIVILEGE_ESCALATION', 'You cannot create a role with permissions you do not hold yourself', { role: b.code, missing });
    }
    let id: string;
    try {
      id = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('roles').values({ code: b.code, name: b.name, description: b.description ?? null, permissions: b.permissions, is_system: false }).returning('id').executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'ROLE_CREATED', resourceType: 'role', resourceId: r.id, details: { code: b.code, name: b.name, permissions: b.permissions } });
        return r.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A role with this code already exists');
      throw e;
    }
    reply.status(201);
    return dto(await baseQuery().where('r.id', '=', id).executeTakeFirstOrThrow());
  });

  app.patch('/:id', { preHandler: app.authorize('roles:manage'), schema: { tags: ['roles'], summary: 'Update a role (name, description, permissions)', params: uuidParam, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const role = await db.selectFrom('roles').select(['id', 'code', 'name', 'description', 'permissions', 'is_system']).where('id', '=', req.params.id).executeTakeFirst();
    if (!role) throw notFound('Role');
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    const root = hasRootPermission(p, 'roles:manage');
    const nextPerms = b.permissions ?? (role.permissions as Permission[]);
    const added = nextPerms.filter((x) => !role.permissions.includes(x));
    const removed = role.permissions.filter((x) => !nextPerms.includes(x as Permission));
    const permsChanged = added.length > 0 || removed.length > 0;

    if (role.is_system && !root) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'System roles can only be changed by a state-level administrator', { role: role.code });
    if (!root) {
      const scope = scopePaths(p, 'roles:manage');
      const outside = await db.selectFrom('user_roles as ur').innerJoin('org_units as o', 'o.id', 'ur.org_unit_id').select(sql<number>`count(*)::int`.as('n'))
        .where('ur.role_id', '=', role.id).where(sql<boolean>`NOT (o.path <@ ${sql.val(scope)}::ltree[])`).executeTakeFirstOrThrow();
      if (outside.n > 0) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'This role is assigned outside your jurisdiction; only a state-level administrator can change it', { role: role.code });
    }
    if (permsChanged && p.grants.some((g) => g.roleCode === role.code)) {
      throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot change the permissions of a role you hold yourself', { role: role.code });
    }
    if (added.length && !root) {
      const missing = added.filter((perm) => !hasPermission(p, perm as Permission));
      if (missing.length) throw await adminDenied(db, req, 'PRIVILEGE_ESCALATION', 'You cannot add permissions you do not hold yourself', { role: role.code, missing });
    }
    const sod = sodViolations(nextPerms);
    if (sod.length) throw await adminDenied(db, req, 'SOD_VIOLATION', `Separation of duties: ${sod.join('; ')}`, { role: role.code, violations: sod });
    if (added.length) {
      // SoD across every current holder's other roles.
      const holders = await db.selectFrom('user_roles').select('user_id').distinct().where('role_id', '=', role.id).execute();
      const affected: string[] = [];
      for (const h of holders) if ((await userSodViolations(db, h.user_id, nextPerms, { excludeRoleId: role.id })).length) affected.push(h.user_id);
      if (affected.length) {
        throw await adminDenied(db, req, 'SOD_VIOLATION', `Separation of duties: ${affected.length} user(s) holding this role would combine conflicting permissions with their other roles`, { role: role.code, affectedUsers: affected.slice(0, 50) });
      }
    }

    await db.transaction().execute(async (tx) => {
      await tx.updateTable('roles').set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.permissions !== undefined ? { permissions: nextPerms } : {}),
      }).where('id', '=', role.id).execute();
      if (removed.length) await assertRootAdministratorRemains(tx);
      await appendAudit(tx, req.actor(), {
        action: 'ROLE_UPDATED', resourceType: 'role', resourceId: role.id,
        details: {
          code: role.code, added, removed,
          ...(b.name !== undefined && b.name !== role.name ? { name: { from: role.name, to: b.name } } : {}),
          ...(b.description !== undefined && b.description !== role.description ? { descriptionChanged: true } : {}),
        },
      });
    });
    // Every holder's effective permissions may have changed.
    invalidatePrincipals();
    return dto(await baseQuery().where('r.id', '=', role.id).executeTakeFirstOrThrow());
  });

  app.delete('/:id', { preHandler: app.authorize('roles:manage'), schema: { tags: ['roles'], summary: 'Delete an unassigned custom role', params: uuidParam } }, async (req) => {
    const role = await baseQuery().where('r.id', '=', req.params.id).executeTakeFirst();
    if (!role) throw notFound('Role');
    if (role.is_system) throw conflict('System roles cannot be deleted');
    if (role.all_assignments > 0) throw conflict(`Role is referenced by ${role.all_assignments} assignment(s); revoke them first`);
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('roles').where('id', '=', role.id).execute();
      await appendAudit(tx, req.actor(), { action: 'ROLE_DELETED', resourceType: 'role', resourceId: role.id, details: { code: role.code, permissions: role.permissions } });
    });
    return { ok: true };
  });
}
