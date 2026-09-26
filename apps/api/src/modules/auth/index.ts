import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { sql } from 'kysely';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, checkPasswordPolicy, type MeResponse } from '@ksp/shared';
import { appendAudit, decryptSecret, dummySecretHash, encryptSecret, hashSecret, randomToken, verifySecret, type AuditActor } from '@ksp/core';
import { createSession, revokeAllUserSessions, revokeSession, rotateRefresh, signJwt, verifyJwt, type IssuedTokens } from '../../lib/session.js';
import { getSettings } from '../../lib/settings.js';
import { invalidatePrincipals, loadUserPrincipal } from '../../lib/load-principal.js';
import { AppError, badRequest, notFound, unauthenticated, validationFailed } from '../../lib/errors.js';
import { authFailures } from '../../plugins/metrics.js';

export const prefix = '/auth';

authenticator.options = { window: 1, step: 30 };
const GENERIC_LOGIN_ERROR = 'Invalid username or password';

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  /** 'cookie' (browser, default) or 'bearer' (station client / scripts: tokens returned in body). */
  tokenMode: z.enum(['cookie', 'bearer']).default('cookie'),
});

export default async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const cfg = app.cfg;

  function setAuthCookies(reply: FastifyReply, t: IssuedTokens) {
    const base = { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'strict' as const };
    reply.setCookie(ACCESS_COOKIE, t.accessToken, { ...base, path: '/', expires: t.accessExpiresAt });
    reply.setCookie(REFRESH_COOKIE, t.refreshToken, { ...base, path: '/api/v1/auth', expires: t.refreshExpiresAt });
    reply.setCookie(CSRF_COOKIE, randomToken(24), { httpOnly: false, secure: cfg.COOKIE_SECURE, sameSite: 'strict', path: '/', expires: t.refreshExpiresAt });
  }
  function clearAuthCookies(reply: FastifyReply) {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }
  const anon = (req: FastifyRequest, id: string | null, name: string | null): AuditActor => ({
    type: 'USER', id, name, ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
  });

  async function respondWithSession(req: FastifyRequest, reply: FastifyReply, userId: string, mode: 'cookie' | 'bearer', mfaVerified: boolean) {
    const tokens = await createSession(db, userId, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, mfaVerified });
    await db.updateTable('users').set({ last_login_at: new Date(), last_login_ip: req.ip, failed_login_count: 0, locked_until: null }).where('id', '=', userId).execute();
    const user = await db.selectFrom('users').select(['username', 'home_org_unit_id']).where('id', '=', userId).executeTakeFirstOrThrow();
    await appendAudit(db, { ...anon(req, userId, user.username), sessionId: tokens.sessionId }, {
      action: 'LOGIN', resourceType: 'session', resourceId: tokens.sessionId, orgUnitId: user.home_org_unit_id, details: { mfa: mfaVerified, mode },
    });
    const me = await buildMe(userId, tokens.sessionId, mfaVerified);
    if (mode === 'bearer') {
      return { me, accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt.toISOString(), refreshToken: tokens.refreshToken, refreshExpiresAt: tokens.refreshExpiresAt.toISOString() };
    }
    setAuthCookies(reply, tokens);
    return { me };
  }

  async function buildMe(userId: string, sessionId: string, mfaVerified: boolean): Promise<MeResponse> {
    invalidatePrincipals(userId);
    const p = await loadUserPrincipal(db, userId, sessionId, mfaVerified);
    if (!p) throw unauthenticated();
    const u = await db
      .selectFrom('users as u')
      .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
      .select(['u.id', 'u.username', 'u.full_name', 'u.email', 'u.badge_number', 'u.rank', 'u.mfa_enabled', 'o.id as org_id', 'o.name as org_name', 'o.code as org_code'])
      .where('u.id', '=', userId)
      .executeTakeFirstOrThrow();
    return {
      user: {
        id: u.id, username: u.username, fullName: u.full_name, email: u.email, badgeNumber: u.badge_number, rank: u.rank,
        homeOrgUnit: { id: u.org_id, name: u.org_name, code: u.org_code }, mfaEnabled: u.mfa_enabled,
        mustChangePassword: p.mustChangePassword, mfaEnrollmentRequired: p.mfaEnrollmentRequired,
      },
      permissions: [...p.permissions].sort(),
      roles: p.grants.map((g) => ({ code: g.roleCode, name: g.roleName, orgUnitId: g.orgUnitId, orgUnitName: g.orgUnitName })),
      sessionId,
    };
  }

  // ---------------------------------------------------------------------------------------------
  app.post('/login', {
    config: { public: true, rateLimit: { max: cfg.NODE_ENV === 'test' ? 10000 : 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], summary: 'Password login (step 1)', body: loginBody },
  }, async (req, reply) => {
    const { username, password, tokenMode } = req.body;
    const settings = await getSettings(db);
    const lp = settings.lockoutPolicy;
    const since = new Date(Date.now() - lp.windowMinutes * 60_000);
    const ipFailures = await db.selectFrom('login_attempts').select(sql<number>`count(*)::int`.as('n'))
      .where('ip', '=', req.ip).where('success', '=', false).where('created_at', '>', since).executeTakeFirstOrThrow();
    if (ipFailures.n >= lp.ipMaxFailedPerWindow) {
      authFailures.inc({ reason: 'ip_throttled' });
      await appendAudit(db, anon(req, null, username), { action: 'RATE_LIMITED', outcome: 'DENIED', resourceType: 'login', details: { username, ipFailures: ipFailures.n } });
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed login attempts from this address. Try again later.');
    }
    const user = await db.selectFrom('users').select(['id', 'username', 'password_hash', 'status', 'locked_until', 'failed_login_count', 'mfa_enabled', 'home_org_unit_id'])
      .where('username', '=', username).executeTakeFirst();
    const ok = await verifySecret(user?.password_hash ?? (await dummySecretHash()), password);
    const record = (success: boolean, reason: string | null) =>
      db.insertInto('login_attempts').values({ username, user_id: user?.id ?? null, ip: req.ip, user_agent: req.headers['user-agent']?.slice(0, 512) ?? null, success, reason }).execute();

    // While locked, answer identically for correct and wrong passwords (the hash is still computed above, so timing is
    // unchanged): otherwise a 423-only-on-correct-password response is a password oracle during the lockout window.
    if (user && user.locked_until && user.locked_until > new Date()) {
      await record(false, ok ? 'LOCKED' : 'LOCKED_BAD_PASSWORD');
      authFailures.inc({ reason: 'locked' });
      await appendAudit(db, anon(req, user.id, username), { action: 'LOGIN_FAILED', outcome: 'DENIED', resourceType: 'login', details: { reason: 'LOCKED' } });
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account is temporarily locked after repeated failed attempts. Try again later or contact an administrator.');
    }
    if (!user || !ok) {
      await record(false, user ? 'BAD_PASSWORD' : 'UNKNOWN_USER');
      authFailures.inc({ reason: user ? 'bad_password' : 'unknown_user' });
      await appendAudit(db, anon(req, user?.id ?? null, username), { action: 'LOGIN_FAILED', outcome: 'FAILURE', resourceType: 'login', details: { reason: user ? 'BAD_PASSWORD' : 'UNKNOWN_USER' } });
      if (user) {
        const count = user.failed_login_count + 1;
        const lock = count >= lp.maxFailedAttempts;
        await db.updateTable('users').set({ failed_login_count: count, locked_until: lock ? new Date(Date.now() + lp.lockoutMinutes * 60_000) : user.locked_until }).where('id', '=', user.id).execute();
        if (lock) await appendAudit(db, anon(req, user.id, username), { action: 'ACCOUNT_LOCKED', outcome: 'SUCCESS', resourceType: 'user', resourceId: user.id, details: { failedAttempts: count, minutes: lp.lockoutMinutes } });
      }
      throw unauthenticated(GENERIC_LOGIN_ERROR);
    }
    if (user.status !== 'ACTIVE') {
      await record(false, `STATUS_${user.status}`);
      await appendAudit(db, anon(req, user.id, username), { action: 'LOGIN_FAILED', outcome: 'DENIED', resourceType: 'login', details: { reason: `STATUS_${user.status}` } });
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is not active. Contact an administrator.');
    }
    await record(true, null);
    if (user.mfa_enabled) {
      const mfaToken = await signJwt({ sub: user.id, typ: 'mfa' }, 300);
      return { mfaRequired: true, mfaToken };
    }
    return respondWithSession(req, reply, user.id, tokenMode, false);
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/mfa/verify', {
    config: { public: true, rateLimit: { max: cfg.NODE_ENV === 'test' ? 10000 : 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'], summary: 'Complete login with a TOTP code or a one-time recovery code (step 2)',
      body: z.object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(32).optional(), tokenMode: z.enum(['cookie', 'bearer']).default('cookie') })
        .refine((b) => !!b.code !== !!b.recoveryCode, 'Provide exactly one of code or recoveryCode'),
    },
  }, async (req, reply) => {
    const claims = await verifyJwt(req.body.mfaToken, 'mfa');
    const user = await db.selectFrom('users').select(['id', 'username', 'mfa_secret_enc', 'mfa_recovery_codes', 'status', 'failed_login_count', 'locked_until']).where('id', '=', claims.sub).executeTakeFirst();
    if (!user || user.status !== 'ACTIVE' || !user.mfa_secret_enc) throw unauthenticated();
    // SEC-11: the lockout applies to the second factor too (otherwise one mfaToken allows unbounded TOTP guessing).
    if (user.locked_until && user.locked_until > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account is temporarily locked after repeated failed attempts. Try again later or contact an administrator.');
    }
    let ok = false;
    let usedRecovery = false;
    if (req.body.code) {
      const delta = authenticator.checkDelta(req.body.code, decryptSecret(user.mfa_secret_enc));
      if (delta !== null) {
        // SEC-12: single use per time step (RFC 6238 §5.2) — atomic, so concurrent replays cannot both pass.
        const step = Math.floor(Date.now() / 30_000) + delta;
        const upd = await db.updateTable('users').set({ mfa_last_totp_step: step }).where('id', '=', user.id)
          .where((eb) => eb.or([eb('mfa_last_totp_step', 'is', null), eb('mfa_last_totp_step', '<', step)])).executeTakeFirst();
        ok = Number(upd.numUpdatedRows) === 1;
      }
    } else if (req.body.recoveryCode) {
      const normalized = req.body.recoveryCode.replace(/[\s-]/g, '').toLowerCase();
      for (let i = 0; i < user.mfa_recovery_codes.length; i++) {
        const hash = user.mfa_recovery_codes[i]!;
        if (await verifySecret(hash, normalized)) {
          // SEC-12: consume atomically (array_remove where still present) so one code cannot open two sessions.
          const upd = await db.updateTable('users').set({ mfa_recovery_codes: sql`array_remove(mfa_recovery_codes, ${hash}::text)` })
            .where('id', '=', user.id).where(sql<boolean>`${hash}::text = ANY(mfa_recovery_codes)`).executeTakeFirst();
          ok = Number(upd.numUpdatedRows) === 1;
          usedRecovery = ok;
          break;
        }
      }
    }
    if (!ok) {
      authFailures.inc({ reason: 'mfa' });
      const settings = await getSettings(db);
      const count = user.failed_login_count + 1;
      const lock = count >= settings.lockoutPolicy.maxFailedAttempts;
      await db.updateTable('users').set({ failed_login_count: count, ...(lock ? { locked_until: new Date(Date.now() + settings.lockoutPolicy.lockoutMinutes * 60_000) } : {}) }).where('id', '=', user.id).execute();
      await appendAudit(db, anon(req, user.id, user.username), { action: 'MFA_CHALLENGE_FAILED', outcome: 'FAILURE', resourceType: 'user', resourceId: user.id });
      throw unauthenticated('Invalid verification code');
    }
    await appendAudit(db, anon(req, user.id, user.username), { action: 'MFA_CHALLENGE_PASSED', resourceType: 'user', resourceId: user.id, details: { recoveryCode: usedRecovery } });
    return respondWithSession(req, reply, user.id, req.body.tokenMode, true);
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/refresh', {
    config: { public: true },
    schema: { tags: ['auth'], summary: 'Rotate refresh token and issue a new access token', body: z.object({ refreshToken: z.string().optional() }).optional() },
  }, async (req, reply) => {
    const bodyToken = req.body?.refreshToken;
    const presented = bodyToken ?? req.cookies[REFRESH_COOKIE];
    if (!presented) throw unauthenticated('No refresh token');
    const result = await rotateRefresh(db, presented);
    if (!result.ok) {
      if (result.reason === 'REUSED') {
        invalidatePrincipals(result.userId);
        await appendAudit(db, { ...anon(req, result.userId ?? null, null), sessionId: result.sessionId ?? null }, {
          action: 'TOKEN_REUSE_DETECTED', outcome: 'DENIED', resourceType: 'session', resourceId: result.sessionId, details: { note: 'refresh token replay; session and token family revoked' },
        });
      }
      clearAuthCookies(reply);
      throw unauthenticated('Session expired. Please sign in again.');
    }
    if (bodyToken) {
      return { accessToken: result.tokens.accessToken, accessExpiresAt: result.tokens.accessExpiresAt.toISOString(), refreshToken: result.tokens.refreshToken, refreshExpiresAt: result.tokens.refreshExpiresAt.toISOString() };
    }
    setAuthCookies(reply, result.tokens);
    return { ok: true, accessExpiresAt: result.tokens.accessExpiresAt.toISOString() };
  });

  app.post('/logout', { config: { allowRestricted: true }, schema: { tags: ['auth'], summary: 'End the current session' } }, async (req, reply) => {
    const p = req.requirePrincipal();
    if (p.sessionId) {
      await revokeSession(db, p.sessionId, 'LOGOUT');
      invalidatePrincipals(p.userId ?? undefined);
      await appendAudit(db, req.actor(), { action: 'LOGOUT', resourceType: 'session', resourceId: p.sessionId });
    }
    clearAuthCookies(reply);
    return { ok: true };
  });

  app.get('/me', { config: { allowRestricted: true }, schema: { tags: ['auth'], summary: 'Current principal, permissions and roles' } }, async (req) => {
    const p = req.requirePrincipal();
    if (p.kind !== 'USER' || !p.userId || !p.sessionId) throw badRequest('Only available to user sessions');
    return buildMe(p.userId, p.sessionId, p.mfaVerified);
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/password/change', {
    config: { allowRestricted: true, rateLimit: { max: cfg.NODE_ENV === 'test' ? 10000 : 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], summary: 'Change own password (enforces policy + history)', body: z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw badRequest('Only available to users');
    const user = await db.selectFrom('users').select(['id', 'password_hash', 'username', 'full_name']).where('id', '=', p.userId).executeTakeFirstOrThrow();
    if (!user.password_hash || !(await verifySecret(user.password_hash, req.body.currentPassword))) {
      await appendAudit(db, req.actor(), { action: 'PASSWORD_CHANGED', outcome: 'FAILURE', resourceType: 'user', resourceId: user.id, details: { reason: 'BAD_CURRENT_PASSWORD' } });
      throw new AppError(400, 'BAD_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    const settings = await getSettings(db);
    const errors = checkPasswordPolicy(req.body.newPassword, settings.passwordPolicy);
    const lowered = req.body.newPassword.toLowerCase();
    if (lowered.includes(user.username.toLowerCase())) errors.push('must not contain your username');
    if (errors.length) throw validationFailed(`Password ${errors.join(', ')}`, { policy: errors });
    const history = await db.selectFrom('password_history').select('password_hash').where('user_id', '=', user.id).orderBy('created_at', 'desc').limit(settings.passwordPolicy.historyCount).execute();
    for (const h of history) if (await verifySecret(h.password_hash, req.body.newPassword)) throw validationFailed(`Password must not match any of your last ${settings.passwordPolicy.historyCount} passwords`);
    const hash = await hashSecret(req.body.newPassword);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ password_hash: hash, password_changed_at: new Date(), must_change_password: false }).where('id', '=', user.id).execute();
      await tx.insertInto('password_history').values({ user_id: user.id, password_hash: hash }).execute();
      await revokeAllUserSessions(tx, user.id, 'PASSWORD_CHANGED', p.sessionId ?? undefined);
      await appendAudit(tx, req.actor(), { action: 'PASSWORD_CHANGED', resourceType: 'user', resourceId: user.id });
    });
    invalidatePrincipals(user.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------------------
  // MFA enrolment (TOTP, RFC 6238)
  app.post('/mfa/setup', { config: { allowRestricted: true }, schema: { tags: ['auth'], summary: 'Begin TOTP enrolment: returns secret + QR code' } }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw badRequest('Only available to users');
    const secret = authenticator.generateSecret(20);
    await db.updateTable('users').set({ mfa_pending_secret_enc: encryptSecret(secret) }).where('id', '=', p.userId).execute();
    const otpauthUrl = authenticator.keyuri(p.username, 'KSP VMS', secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  });

  app.post('/mfa/confirm', {
    config: { allowRestricted: true },
    schema: { tags: ['auth'], summary: 'Confirm TOTP enrolment with a code; returns one-time recovery codes', body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw badRequest('Only available to users');
    const u = await db.selectFrom('users').select(['mfa_pending_secret_enc']).where('id', '=', p.userId).executeTakeFirstOrThrow();
    if (!u.mfa_pending_secret_enc) throw badRequest('No MFA enrolment in progress');
    const secret = decryptSecret(u.mfa_pending_secret_enc);
    const delta = authenticator.checkDelta(req.body.code, secret);
    if (delta === null) throw new AppError(400, 'INVALID_CODE', 'Invalid verification code');
    const codes = Array.from({ length: 10 }, () => randomToken(8).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase());
    const hashes = await Promise.all(codes.map((c) => hashSecret(c)));
    await db.transaction().execute(async (tx) => {
      // The enrolment code is consumed too (SEC-12): it cannot be replayed at the next login.
      await tx.updateTable('users').set({ mfa_enabled: true, mfa_secret_enc: encryptSecret(secret), mfa_pending_secret_enc: null, mfa_recovery_codes: hashes, mfa_enrolled_at: new Date(), mfa_last_totp_step: Math.floor(Date.now() / 30_000) + delta }).where('id', '=', p.userId!).execute();
      if (p.sessionId) await tx.updateTable('sessions').set({ mfa_verified: true }).where('id', '=', p.sessionId).execute();
      await appendAudit(tx, req.actor(), { action: 'MFA_ENROLLED', resourceType: 'user', resourceId: p.userId! });
    });
    invalidatePrincipals(p.userId);
    return { recoveryCodes: codes };
  });

  app.post('/mfa/disable', {
    schema: { tags: ['auth'], summary: 'Disable own MFA (requires password + current code; blocked when MFA is mandatory for your roles)', body: z.object({ password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw badRequest('Only available to users');
    const settings = await getSettings(db);
    if (p.grants.some((g) => settings.sessionPolicy.requireMfaForRoles.includes(g.roleCode))) throw new AppError(403, 'MFA_MANDATORY', 'MFA is mandatory for your role and cannot be disabled');
    const u = await db.selectFrom('users').select(['password_hash', 'mfa_secret_enc']).where('id', '=', p.userId).executeTakeFirstOrThrow();
    if (!u.password_hash || !(await verifySecret(u.password_hash, req.body.password)) || !u.mfa_secret_enc || !authenticator.check(req.body.code, decryptSecret(u.mfa_secret_enc))) {
      throw new AppError(400, 'INVALID_CREDENTIALS', 'Password or code is incorrect');
    }
    await db.updateTable('users').set({ mfa_enabled: false, mfa_secret_enc: null, mfa_recovery_codes: [], mfa_enrolled_at: null }).where('id', '=', p.userId).execute();
    await appendAudit(db, req.actor(), { action: 'MFA_DISABLED', resourceType: 'user', resourceId: p.userId });
    invalidatePrincipals(p.userId);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/sessions', { schema: { tags: ['auth'], summary: 'List own active sessions' } }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) throw badRequest('Only available to users');
    const rows = await db.selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'ip', 'user_agent', 'mfa_verified', 'idle_expires_at', 'absolute_expires_at'])
      .where('user_id', '=', p.userId).where('revoked_at', 'is', null).where('absolute_expires_at', '>', new Date()).where('idle_expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc').execute();
    return { items: rows.map((r) => ({ ...r, current: r.id === p.sessionId })) };
  });

  app.delete('/sessions/:id', { schema: { tags: ['auth'], summary: 'Revoke one of own sessions', params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const p = req.requirePrincipal();
    const s = await db.selectFrom('sessions').select(['id']).where('id', '=', req.params.id).where('user_id', '=', p.userId ?? '00000000-0000-0000-0000-000000000000').executeTakeFirst();
    if (!s) throw notFound('Session');
    await revokeSession(db, s.id, 'USER_REVOKED');
    invalidatePrincipals(p.userId ?? undefined);
    await appendAudit(db, req.actor(), { action: 'SESSION_REVOKED', resourceType: 'session', resourceId: s.id });
    return { ok: true };
  });
}
