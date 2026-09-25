/**
 * User administration (spec: user & role administration). Jurisdiction-scoped by the account's HOME org unit:
 *   read  : users:read (or users:manage / roles:manage) at the home unit — otherwise 404;
 *   write : users:manage at the home unit (403 when visible but not manageable);
 *   roles : roles:manage at the grant's org unit + the grantor rule (see admin-lib.ts, docs/AUTHORIZATION.md).
 * Secrets (password hashes, MFA secrets, recovery codes) are never returned. One-time passwords are returned
 * exactly once in the response that created them and are never logged or audited.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { sodViolations, type Permission } from '@ksp/shared';
import { appendAudit, hashSecret, isUniqueViolation, type Database, type Tx } from '@ksp/core';
import { hasPermissionAt, type Principal } from '../../lib/principal.js';
import { invalidatePrincipals } from '../../lib/load-principal.js';
import { revokeAllUserSessions, revokeSession } from '../../lib/session.js';
import { getSettings } from '../../lib/settings.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import {
  adminDenied, assertMayGrant, assertRootAdministratorRemains, canSeeUserAt, generateTemporaryPassword, likePattern, loadOrgUnit,
  loadScopedUser, pageFields, reasonField, unionScope, uuidParam,
} from './admin-lib.js';

export const prefix = '/users';

const USER_STATUSES = ['PENDING', 'ACTIVE', 'LOCKED', 'DISABLED'] as const;
const SORTS = { username: 'u.username', fullName: 'u.full_name', createdAt: 'u.created_at', lastLoginAt: 'u.last_login_at', status: 'u.status' } as const;
type SortKey = keyof typeof SORTS;
const sortValues = Object.keys(SORTS).flatMap((k) => [k, `-${k}`]) as [string, ...string[]];

const optText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const profileFields = {
  fullName: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  badgeNumber: optText(64),
  rank: optText(100),
  designation: optText(200),
  phone: z.string().trim().regex(/^[0-9+() -]{6,20}$/, 'Invalid phone number').nullable().optional().or(z.literal('').transform(() => null)),
  homeOrgUnitId: z.string().uuid(),
};
const roleGrant = z.object({
  roleId: z.string().uuid(),
  orgUnitId: z.string().uuid(),
  expiresAt: z.coerce.date().nullable().optional(),
}).strict();

const createBody = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'Username: 3-64 chars, lowercase letters, digits, dot, dash, underscore'),
  ...profileFields,
  roles: z.array(roleGrant).max(20).default([]),
}).strict();
const patchBody = z.object(profileFields).partial().strict();

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(USER_STATUSES).optional(),
  orgUnitId: z.string().uuid().optional(),
  roleCode: z.string().trim().max(42).optional(),
  sort: z.enum(sortValues).default('fullName'),
  ...pageFields,
});

export default async function users(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  function requireSeeUsers(p: Principal) {
    if (!(['users:read', 'users:manage', 'roles:manage'] as Permission[]).some((perm) => p.permissions.has(perm))) throw forbidden();
  }

  async function assignments(dbx: Database | Tx, userId: string) {
    const rows = await dbx
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
      .leftJoin('users as g', 'g.id', 'ur.granted_by')
      .select(['ur.id', 'ur.role_id', 'r.code', 'r.name', 'r.is_system', 'o.id as org_id', 'o.name as org_name', 'o.path', 'o.active as org_active', 'ur.granted_at', 'ur.expires_at', 'g.id as g_id', 'g.full_name as g_name'])
      .where('ur.user_id', '=', userId)
      .orderBy('ur.granted_at')
      .execute();
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, roleId: r.role_id, roleCode: r.code, roleName: r.name, isSystemRole: r.is_system,
      orgUnitId: r.org_id, orgUnitName: r.org_name, orgUnitPath: r.path, orgUnitActive: r.org_active,
      grantedAt: r.granted_at, grantedBy: r.g_id ? { id: r.g_id, fullName: r.g_name } : null,
      expiresAt: r.expires_at, expired: !!r.expires_at && r.expires_at.getTime() <= now,
    }));
  }

  async function detail(p: Principal, id: string) {
    const u = await db
      .selectFrom('users as u')
      .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
      .leftJoin('users as c', 'c.id', 'u.created_by')
      .select([
        'u.id', 'u.username', 'u.full_name', 'u.email', 'u.badge_number', 'u.rank', 'u.designation', 'u.phone', 'u.status',
        'u.must_change_password', 'u.password_changed_at', 'u.failed_login_count', 'u.locked_until', 'u.mfa_enabled', 'u.mfa_enrolled_at',
        'u.last_login_at', 'u.last_login_ip', 'u.created_at', 'u.updated_at', 'u.disabled_at', 'u.disabled_reason',
        'o.id as org_id', 'o.name as org_name', 'o.code as org_code', 'o.path as org_path', 'c.id as c_id', 'c.full_name as c_name',
      ])
      .where('u.id', '=', id)
      .executeTakeFirst();
    if (!u || !canSeeUserAt(p, u.org_path)) throw notFound('User');
    const sessions = await db.selectFrom('sessions').select(sql<number>`count(*)::int`.as('n'))
      .where('user_id', '=', id).where('revoked_at', 'is', null).where('idle_expires_at', '>', new Date()).where('absolute_expires_at', '>', new Date())
      .executeTakeFirstOrThrow();
    const now = new Date();
    return {
      id: u.id, username: u.username, fullName: u.full_name, email: u.email, badgeNumber: u.badge_number, rank: u.rank,
      designation: u.designation, phone: u.phone, status: u.status,
      homeOrgUnit: { id: u.org_id, name: u.org_name, code: u.org_code, path: u.org_path },
      mustChangePassword: u.must_change_password, passwordChangedAt: u.password_changed_at,
      failedLoginCount: u.failed_login_count, lockedUntil: u.locked_until && u.locked_until > now ? u.locked_until : null,
      locked: u.status === 'LOCKED' || (!!u.locked_until && u.locked_until > now),
      mfaEnabled: u.mfa_enabled, mfaEnrolledAt: u.mfa_enrolled_at,
      lastLoginAt: u.last_login_at, lastLoginIp: u.last_login_ip,
      statusChangedAt: u.disabled_at, statusReason: u.disabled_reason,
      createdAt: u.created_at, updatedAt: u.updated_at, createdBy: u.c_id ? { id: u.c_id, fullName: u.c_name } : null,
      activeSessions: sessions.n,
      roles: await assignments(db, id),
      isSelf: p.userId === u.id,
      canManage: hasPermissionAt(p, 'users:manage', u.org_path),
      canManageRoles: hasPermissionAt(p, 'roles:manage', u.org_path),
    };
  }

  /** Every administrative credential/status action invalidates cached principals for the account. */
  const done = (userId: string) => invalidatePrincipals(userId);

  // -------------------------------------------------------------------------------------------
  app.get('/', { preHandler: app.authorize('users:read'), schema: { tags: ['users'], summary: 'List user accounts within jurisdiction', querystring: listQuery } }, async (req) => {
    const p = req.requirePrincipal();
    const { q, status, orgUnitId, roleCode, sort, page, pageSize } = req.query;
    const scope = unionScope(p, ['users:read', 'users:manage']);
    if (!scope.length) return { items: [], total: 0, page, pageSize };
    let base = db
      .selectFrom('users as u')
      .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
      .where(sql<boolean>`o.path <@ ${sql.val(scope)}::ltree[]`);
    if (q) {
      const like = likePattern(q);
      base = base.where((eb) => eb.or([eb('u.full_name', 'ilike', like), eb(sql`u.username::text`, 'ilike', like), eb('u.badge_number', 'ilike', like), eb(sql`u.email::text`, 'ilike', like)]));
    }
    if (status) base = base.where('u.status', '=', status);
    if (orgUnitId) base = base.where(sql<boolean>`o.path <@ (SELECT path FROM org_units WHERE id = ${orgUnitId}::uuid)`);
    if (roleCode) {
      base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.code = ${roleCode} AND (ur.expires_at IS NULL OR ur.expires_at > now()))`);
    }
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const desc = sort.startsWith('-');
    const col = SORTS[sort.replace(/^-/, '') as SortKey];
    const rows = await base
      .select([
        'u.id', 'u.username', 'u.full_name', 'u.email', 'u.badge_number', 'u.rank', 'u.designation', 'u.status', 'u.mfa_enabled',
        'u.last_login_at', 'u.locked_until', 'u.created_at', 'o.id as org_id', 'o.name as org_name', 'o.code as org_code',
      ])
      .select(sql<string[]>`ARRAY(SELECT DISTINCT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND (ur.expires_at IS NULL OR ur.expires_at > now()) ORDER BY r.code)`.as('role_codes'))
      .orderBy(sql.ref(col), sql.raw(desc ? 'desc nulls last' : 'asc nulls last'))
      .orderBy('u.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    const now = new Date();
    return {
      items: rows.map((r) => ({
        id: r.id, username: r.username, fullName: r.full_name, email: r.email, badgeNumber: r.badge_number, rank: r.rank, designation: r.designation,
        status: r.status, mfaEnabled: r.mfa_enabled, lastLoginAt: r.last_login_at, locked: r.status === 'LOCKED' || (!!r.locked_until && r.locked_until > now),
        createdAt: r.created_at, homeOrgUnit: { id: r.org_id, name: r.org_name, code: r.org_code }, roleCodes: r.role_codes,
      })),
      total: total.n,
      page,
      pageSize,
    };
  });

  app.get('/:id', { schema: { tags: ['users'], summary: 'User account detail (roles, sessions, MFA and lock state)', params: uuidParam } }, async (req) => {
    const p = req.requirePrincipal();
    requireSeeUsers(p);
    return detail(p, req.params.id);
  });

  // -------------------------------------------------------------------------------------------
  app.post('/', {
    preHandler: app.authorize('users:manage'),
    schema: { tags: ['users'], summary: 'Create a user account; returns a one-time temporary password (shown once)', body: createBody },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const home = await loadOrgUnit(db, b.homeOrgUnitId).catch(() => { throw validationFailed('Home org unit not found'); });
    if (!hasPermissionAt(p, 'users:manage', home.path)) {
      throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot create users outside your jurisdiction', { homeOrgUnitId: home.id });
    }
    if (!home.active) throw conflict('Users cannot be created in an inactive org unit');
    // Validate every initial role grant with the same rules as POST /users/:id/roles.
    const grants: Array<{ role: { id: string; code: string; permissions: string[] }; org: { id: string; path: string }; expiresAt: Date | null }> = [];
    if (b.roles.length && !p.permissions.has('roles:manage')) throw forbidden('Assigning roles requires roles:manage');
    for (const g of b.roles) {
      const role = await db.selectFrom('roles').select(['id', 'code', 'permissions']).where('id', '=', g.roleId).executeTakeFirst();
      if (!role) throw validationFailed('Unknown role');
      const org = await loadOrgUnit(db, g.orgUnitId).catch(() => { throw validationFailed('Role org unit not found'); });
      if (g.expiresAt && g.expiresAt <= new Date()) throw validationFailed('Role expiry must be in the future');
      await assertMayGrant(db, req, p, role, org, null);
      grants.push({ role, org, expiresAt: g.expiresAt ?? null });
    }
    const sod = sodViolations(grants.flatMap((g) => g.role.permissions));
    if (sod.length) throw await adminDenied(db, req, 'SOD_VIOLATION', `Separation of duties: ${sod.join('; ')}`, { violations: sod });

    const settings = await getSettings(db);
    const temporaryPassword = generateTemporaryPassword(settings.passwordPolicy);
    const hash = await hashSecret(temporaryPassword);
    let id: string;
    try {
      id = await db.transaction().execute(async (tx) => {
        const u = await tx.insertInto('users').values({
          username: b.username, full_name: b.fullName, email: b.email ?? null, badge_number: b.badgeNumber ?? null, rank: b.rank ?? null,
          designation: b.designation ?? null, phone: b.phone ?? null, home_org_unit_id: home.id, status: 'ACTIVE',
          password_hash: hash, password_changed_at: new Date(), must_change_password: true, created_by: p.userId,
        }).returning('id').executeTakeFirstOrThrow();
        await tx.insertInto('password_history').values({ user_id: u.id, password_hash: hash }).execute();
        for (const g of grants) {
          await tx.insertInto('user_roles').values({ user_id: u.id, role_id: g.role.id, org_unit_id: g.org.id, granted_by: p.userId, expires_at: g.expiresAt }).execute();
        }
        await appendAudit(tx, req.actor(), {
          action: 'USER_CREATED', resourceType: 'user', resourceId: u.id, orgUnitId: home.id,
          details: { username: b.username, roles: grants.map((g) => ({ role: g.role.code, orgUnitId: g.org.id, expiresAt: g.expiresAt })) },
        });
        for (const g of grants) {
          await appendAudit(tx, req.actor(), { action: 'ROLE_GRANTED', resourceType: 'user', resourceId: u.id, orgUnitId: g.org.id, details: { role: g.role.code, expiresAt: g.expiresAt } });
        }
        return u.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A user with this username, email or badge number already exists');
      throw e;
    }
    reply.status(201);
    return { user: await detail(p, id), temporaryPassword };
  });

  app.patch('/:id', { schema: { tags: ['users'], summary: 'Update a user profile', params: uuidParam, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    const b = req.body;
    if (b.homeOrgUnitId && b.homeOrgUnitId !== target.home_org_unit_id) {
      if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot move your own account to another org unit');
      const org = await loadOrgUnit(db, b.homeOrgUnitId).catch(() => { throw validationFailed('Home org unit not found'); });
      if (!hasPermissionAt(p, 'users:manage', org.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot move a user outside your jurisdiction', { homeOrgUnitId: org.id });
      if (!org.active) throw conflict('Users cannot be moved to an inactive org unit');
    }
    const map = { fullName: 'full_name', email: 'email', badgeNumber: 'badge_number', rank: 'rank', designation: 'designation', phone: 'phone', homeOrgUnitId: 'home_org_unit_id' } as const;
    const set: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) if ((b as Record<string, unknown>)[k] !== undefined) set[col] = (b as Record<string, unknown>)[k];
    if (!Object.keys(set).length) throw validationFailed('Nothing to update');
    try {
      await db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('users').select(['full_name', 'email', 'badge_number', 'rank', 'designation', 'phone', 'home_org_unit_id']).where('id', '=', target.id).executeTakeFirstOrThrow();
        await tx.updateTable('users').set(set).where('id', '=', target.id).execute();
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [col, v] of Object.entries(set)) changes[col] = { from: (before as Record<string, unknown>)[col], to: v };
        await appendAudit(tx, req.actor(), { action: 'USER_UPDATED', resourceType: 'user', resourceId: target.id, orgUnitId: (set.home_org_unit_id as string) ?? target.home_org_unit_id, details: { changes } });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Another user already has this email or badge number');
      throw e;
    }
    done(target.id);
    return detail(p, target.id);
  });

  // -------------------------------------------------------------------------------------------
  app.post('/:id/status', {
    schema: {
      tags: ['users'], summary: 'Change account status (ACTIVE / LOCKED / DISABLED). Locking or disabling revokes all sessions.',
      params: uuidParam, body: z.object({ status: z.enum(['ACTIVE', 'LOCKED', 'DISABLED']), reason: reasonField }).strict(),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    const { status, reason } = req.body;
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot change the status of your own account');
    if (target.status === status) throw conflict(`Account is already ${status}`);
    let revoked = 0;
    await db.transaction().execute(async (tx) => {
      if (status === 'ACTIVE') {
        await tx.updateTable('users').set({ status, disabled_at: null, disabled_reason: null, locked_until: null, failed_login_count: 0 }).where('id', '=', target.id).execute();
      } else {
        await tx.updateTable('users').set({ status, disabled_at: new Date(), disabled_reason: reason }).where('id', '=', target.id).execute();
        revoked = await revokeAllUserSessions(tx, target.id, status === 'DISABLED' ? 'ACCOUNT_DISABLED' : 'ACCOUNT_LOCKED');
        await assertRootAdministratorRemains(tx);
      }
      await appendAudit(tx, req.actor(), {
        action: 'USER_STATUS_CHANGED', resourceType: 'user', resourceId: target.id, orgUnitId: target.home_org_unit_id,
        details: { from: target.status, to: status, reason, sessionsRevoked: revoked },
      });
    });
    done(target.id);
    return detail(p, target.id);
  });

  app.post('/:id/unlock', {
    schema: { tags: ['users'], summary: 'Clear a failed-login lockout (and an administrative LOCKED status)', params: uuidParam, body: z.object({ reason: reasonField.optional() }).strict().optional() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot unlock your own account');
    if (target.status === 'DISABLED') throw conflict('Account is disabled; re-activate it instead');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ locked_until: null, failed_login_count: 0, ...(target.status === 'LOCKED' ? { status: 'ACTIVE', disabled_at: null, disabled_reason: null } : {}) }).where('id', '=', target.id).execute();
      await appendAudit(tx, req.actor(), { action: 'USER_UNLOCKED', resourceType: 'user', resourceId: target.id, orgUnitId: target.home_org_unit_id, details: { previousStatus: target.status, reason: req.body?.reason ?? null } });
    });
    done(target.id);
    return detail(p, target.id);
  });

  app.post('/:id/reset-password', {
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10000 : 20, timeWindow: '1 minute' } },
    schema: { tags: ['users'], summary: 'Administrative password reset: one-time temporary password (shown once); revokes all sessions', params: uuidParam, body: z.object({ reason: reasonField }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'Use "change password" for your own account');
    const settings = await getSettings(db);
    const temporaryPassword = generateTemporaryPassword(settings.passwordPolicy);
    const hash = await hashSecret(temporaryPassword);
    let revoked = 0;
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ password_hash: hash, password_changed_at: new Date(), must_change_password: true, failed_login_count: 0, locked_until: null }).where('id', '=', target.id).execute();
      await tx.insertInto('password_history').values({ user_id: target.id, password_hash: hash }).execute();
      revoked = await revokeAllUserSessions(tx, target.id, 'PASSWORD_RESET');
      await appendAudit(tx, req.actor(), { action: 'USER_PASSWORD_RESET', resourceType: 'user', resourceId: target.id, orgUnitId: target.home_org_unit_id, details: { reason: req.body.reason, sessionsRevoked: revoked } });
    });
    done(target.id);
    return { temporaryPassword, mustChangePassword: true, sessionsRevoked: revoked };
  });

  app.post('/:id/reset-mfa', {
    schema: { tags: ['users'], summary: 'Reset MFA (user must re-enrol if MFA is mandatory for their roles); revokes all sessions', params: uuidParam, body: z.object({ reason: reasonField }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot reset your own MFA');
    let revoked = 0;
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ mfa_enabled: false, mfa_secret_enc: null, mfa_pending_secret_enc: null, mfa_recovery_codes: [], mfa_enrolled_at: null }).where('id', '=', target.id).execute();
      revoked = await revokeAllUserSessions(tx, target.id, 'MFA_RESET');
      await appendAudit(tx, req.actor(), { action: 'USER_MFA_RESET', resourceType: 'user', resourceId: target.id, orgUnitId: target.home_org_unit_id, details: { reason: req.body.reason, sessionsRevoked: revoked } });
    });
    done(target.id);
    return detail(p, target.id);
  });

  // -------------------------------------------------------------------------------------------
  app.get('/:id/sessions', { schema: { tags: ['users'], summary: "A user's active sessions", params: uuidParam } }, async (req) => {
    const p = req.requirePrincipal();
    requireSeeUsers(p);
    const target = await loadScopedUser(db, p, req.params.id, null);
    const now = new Date();
    const rows = await db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'ip', 'user_agent', 'mfa_verified', 'idle_expires_at', 'absolute_expires_at'])
      .where('user_id', '=', target.id).where('revoked_at', 'is', null).where('absolute_expires_at', '>', now).where('idle_expires_at', '>', now)
      .orderBy('last_seen_at', 'desc').execute();
    return {
      items: rows.map((r) => ({
        id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent, mfaVerified: r.mfa_verified,
        idleExpiresAt: r.idle_expires_at, absoluteExpiresAt: r.absolute_expires_at, current: r.id === p.sessionId,
      })),
    };
  });

  app.delete('/:id/sessions/:sessionId', {
    schema: { tags: ['users'], summary: "Revoke one of a user's sessions", params: z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    const s = await db.selectFrom('sessions').select('id').where('id', '=', req.params.sessionId).where('user_id', '=', target.id).where('revoked_at', 'is', null).executeTakeFirst();
    if (!s) throw notFound('Session');
    await db.transaction().execute(async (tx) => {
      await revokeSession(tx, s.id, 'ADMIN_REVOKED');
      await appendAudit(tx, req.actor(), { action: 'SESSION_REVOKED', resourceType: 'session', resourceId: s.id, orgUnitId: target.home_org_unit_id, details: { userId: target.id, byAdministrator: true } });
    });
    done(target.id);
    return { ok: true };
  });

  app.post('/:id/sessions/revoke-all', {
    schema: { tags: ['users'], summary: "Revoke all of a user's sessions (forces sign-out everywhere)", params: uuidParam, body: z.object({ reason: reasonField.optional() }).strict().optional() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, 'users:manage');
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'Use your own session list to sign out other devices');
    let revoked = 0;
    await db.transaction().execute(async (tx) => {
      revoked = await revokeAllUserSessions(tx, target.id, 'ADMIN_REVOKED');
      await tx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('revoked_at', 'is', null)
        .where('session_id', 'in', tx.selectFrom('sessions').select('id').where('user_id', '=', target.id)).execute();
      await appendAudit(tx, req.actor(), { action: 'SESSION_REVOKED', resourceType: 'user', resourceId: target.id, orgUnitId: target.home_org_unit_id, details: { all: true, count: revoked, reason: req.body?.reason ?? null } });
    });
    done(target.id);
    return { revoked };
  });

  // -------------------------------------------------------------------------------------------
  app.post('/:id/roles', {
    preHandler: app.authorize('roles:manage'),
    schema: { tags: ['users'], summary: 'Grant a role at an org unit (applies to its subtree); optional expiry', params: uuidParam, body: roleGrant },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, null);
    if (target.status === 'DISABLED') throw conflict('Roles cannot be granted to a disabled account');
    const role = await db.selectFrom('roles').select(['id', 'code', 'name', 'permissions']).where('id', '=', req.body.roleId).executeTakeFirst();
    if (!role) throw validationFailed('Unknown role');
    const org = await loadOrgUnit(db, req.body.orgUnitId).catch(() => { throw validationFailed('Org unit not found'); });
    const expiresAt = req.body.expiresAt ?? null;
    if (expiresAt && expiresAt <= new Date()) throw validationFailed('Role expiry must be in the future');
    await assertMayGrant(db, req, p, role, org, target.id);
    let assignmentId: string;
    try {
      assignmentId = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('user_roles').values({ user_id: target.id, role_id: role.id, org_unit_id: org.id, granted_by: p.userId, expires_at: expiresAt }).returning('id').executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'ROLE_GRANTED', resourceType: 'user', resourceId: target.id, orgUnitId: org.id, details: { role: role.code, assignmentId: r.id, expiresAt } });
        return r.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('The user already has this role at this org unit (revoke it first to change the expiry)');
      throw e;
    }
    done(target.id);
    reply.status(201);
    return { assignmentId, user: await detail(p, target.id) };
  });

  app.delete('/:id/roles/:assignmentId', {
    preHandler: app.authorize('roles:manage'),
    schema: { tags: ['users'], summary: 'Revoke a role assignment', params: z.object({ id: z.string().uuid(), assignmentId: z.string().uuid() }), body: z.object({ reason: reasonField.optional() }).strict().optional() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const target = await loadScopedUser(db, p, req.params.id, null);
    const a = await db.selectFrom('user_roles as ur').innerJoin('roles as r', 'r.id', 'ur.role_id').innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
      .select(['ur.id', 'r.code', 'o.id as org_id', 'o.path']).where('ur.id', '=', req.params.assignmentId).where('ur.user_id', '=', target.id).executeTakeFirst();
    if (!a) throw notFound('Role assignment');
    if (target.id === p.userId) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot change your own role assignments', { role: a.code });
    if (!hasPermissionAt(p, 'roles:manage', a.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'This role was granted at an org unit outside your jurisdiction', { role: a.code, orgUnitId: a.org_id });
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('user_roles').where('id', '=', a.id).execute();
      await assertRootAdministratorRemains(tx);
      await appendAudit(tx, req.actor(), { action: 'ROLE_REVOKED', resourceType: 'user', resourceId: target.id, orgUnitId: a.org_id, details: { role: a.code, assignmentId: a.id, reason: req.body?.reason ?? null } });
    });
    done(target.id);
    return detail(p, target.id);
  });
}

