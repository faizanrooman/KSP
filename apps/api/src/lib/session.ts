/**
 * Sessions & tokens.
 *   access token : EdDSA JWT (15 min) {sub, sid, typ:'access'} — sent as httpOnly cookie or Bearer header.
 *   refresh token: opaque 256-bit random, stored as SHA-256 hash, single-use, rotated on every refresh.
 *                  Presenting an already-used refresh token = theft signal => whole family + session revoked.
 *   mfa token    : EdDSA JWT (5 min) {sub, typ:'mfa'} issued after password step when MFA is enabled.
 * Every authenticated request re-checks the session row (revocation + idle timeout take effect immediately).
 */
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import { loadConfig, randomToken, sha256Hex, type Database, type Tx } from '@ksp/core';
import { getSettings } from './settings.js';
import { unauthenticated } from './errors.js';

let keys: Promise<{ priv: CryptoKey; pub: CryptoKey }> | undefined;
function jwtKeys() {
  const cfg = loadConfig();
  return (keys ??= Promise.all([importPKCS8(cfg.JWT_PRIVATE_KEY, 'EdDSA'), importSPKI(cfg.JWT_PUBLIC_KEY, 'EdDSA')]).then(([priv, pub]) => ({ priv, pub })));
}

export interface AccessClaims extends JWTPayload {
  sub: string;
  sid: string;
  typ: 'access' | 'mfa';
}

export async function signJwt(claims: { sub: string; sid?: string; typ: 'access' | 'mfa' }, ttlSeconds: number): Promise<string> {
  const { priv } = await jwtKeys();
  const cfg = loadConfig();
  return new SignJWT({ sid: claims.sid, typ: claims.typ })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.sub)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience(cfg.JWT_ISSUER)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(priv);
}

export async function verifyJwt(token: string, typ: 'access' | 'mfa'): Promise<AccessClaims> {
  const { pub } = await jwtKeys();
  const cfg = loadConfig();
  try {
    const { payload } = await jwtVerify(token, pub, { issuer: cfg.JWT_ISSUER, audience: cfg.JWT_ISSUER, algorithms: ['EdDSA'] });
    if (payload.typ !== typ || typeof payload.sub !== 'string') throw new Error('wrong token type');
    return payload as AccessClaims;
  } catch {
    throw unauthenticated('Invalid or expired token');
  }
}

export interface IssuedTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

async function newRefresh(db: Database | Tx, sessionId: string, familyId: string, parentId: string | null, expiresAt: Date) {
  const token = randomToken(32);
  await db
    .insertInto('refresh_tokens')
    .values({ session_id: sessionId, token_hash: sha256Hex(token), family_id: familyId, parent_id: parentId, expires_at: expiresAt })
    .execute();
  return token;
}

/** Create a session for a fully-authenticated user (password + MFA if enabled). Enforces max concurrent sessions. */
export async function createSession(
  db: Database,
  userId: string,
  meta: { ip: string | null; userAgent: string | null; mfaVerified: boolean },
): Promise<IssuedTokens> {
  const cfg = loadConfig();
  const settings = await getSettings(db);
  const now = Date.now();
  const idle = new Date(now + settings.sessionPolicy.idleTimeoutMinutes * 60_000);
  const absolute = new Date(now + settings.sessionPolicy.absoluteTimeoutHours * 3_600_000);
  return db.transaction().execute(async (tx) => {
    // Enforce concurrent-session limit: revoke the oldest sessions beyond the limit.
    const active = await tx
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('absolute_expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .execute();
    const excess = active.slice(Math.max(0, settings.sessionPolicy.maxConcurrentSessions - 1)).map((s) => s.id);
    if (excess.length) {
      await tx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'CONCURRENT_LIMIT' }).where('id', 'in', excess).execute();
    }
    const session = await tx
      .insertInto('sessions')
      .values({ user_id: userId, idle_expires_at: idle, absolute_expires_at: absolute, ip: meta.ip, user_agent: meta.userAgent?.slice(0, 512) ?? null, mfa_verified: meta.mfaVerified })
      .returning('id')
      .executeTakeFirstOrThrow();
    const refreshExpiresAt = new Date(Math.min(absolute.getTime(), now + cfg.REFRESH_TOKEN_TTL_HOURS * 3_600_000));
    const refreshToken = await newRefresh(tx, session.id, randomUUID(), null, refreshExpiresAt);
    const accessToken = await signJwt({ sub: userId, sid: session.id, typ: 'access' }, cfg.ACCESS_TOKEN_TTL_SECONDS);
    return { accessToken, accessExpiresAt: new Date(now + cfg.ACCESS_TOKEN_TTL_SECONDS * 1000), refreshToken, refreshExpiresAt, sessionId: session.id };
  });
}

export type RefreshOutcome =
  | { ok: true; tokens: IssuedTokens; userId: string }
  | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'REUSED' | 'SESSION_ENDED'; userId?: string; sessionId?: string };

/** Rotate a refresh token. Reuse of a consumed token revokes the entire family and its session. */
export async function rotateRefresh(db: Database, presented: string): Promise<RefreshOutcome> {
  const cfg = loadConfig();
  const settings = await getSettings(db);
  return db.transaction().execute(async (tx): Promise<RefreshOutcome> => {
    const rt = await tx
      .selectFrom('refresh_tokens as r')
      .innerJoin('sessions as s', 's.id', 'r.session_id')
      .select(['r.id', 'r.session_id', 'r.family_id', 'r.expires_at', 'r.used_at', 'r.revoked_at', 's.user_id', 's.revoked_at as session_revoked_at', 's.absolute_expires_at', 's.idle_expires_at'])
      .where('r.token_hash', '=', sha256Hex(presented))
      .forUpdate()
      .executeTakeFirst();
    if (!rt) return { ok: false, reason: 'INVALID' };
    if (rt.used_at || rt.revoked_at) {
      await tx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('family_id', '=', rt.family_id).where('revoked_at', 'is', null).execute();
      await tx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'REFRESH_TOKEN_REUSE' }).where('id', '=', rt.session_id).where('revoked_at', 'is', null).execute();
      return { ok: false, reason: 'REUSED', userId: rt.user_id, sessionId: rt.session_id };
    }
    const now = new Date();
    if (rt.expires_at < now) return { ok: false, reason: 'EXPIRED', userId: rt.user_id };
    if (rt.session_revoked_at || rt.absolute_expires_at < now || rt.idle_expires_at < now) {
      return { ok: false, reason: 'SESSION_ENDED', userId: rt.user_id, sessionId: rt.session_id };
    }
    const user = await tx.selectFrom('users').select(['status', 'locked_until']).where('id', '=', rt.user_id).executeTakeFirstOrThrow();
    if (user.status !== 'ACTIVE') return { ok: false, reason: 'SESSION_ENDED', userId: rt.user_id, sessionId: rt.session_id };
    await tx.updateTable('refresh_tokens').set({ used_at: now }).where('id', '=', rt.id).execute();
    const idle = new Date(Math.min(rt.absolute_expires_at.getTime(), now.getTime() + settings.sessionPolicy.idleTimeoutMinutes * 60_000));
    await tx.updateTable('sessions').set({ last_seen_at: now, idle_expires_at: idle }).where('id', '=', rt.session_id).execute();
    const refreshExpiresAt = new Date(Math.min(rt.absolute_expires_at.getTime(), now.getTime() + cfg.REFRESH_TOKEN_TTL_HOURS * 3_600_000));
    const refreshToken = await newRefresh(tx, rt.session_id, rt.family_id, rt.id, refreshExpiresAt);
    const accessToken = await signJwt({ sub: rt.user_id, sid: rt.session_id, typ: 'access' }, cfg.ACCESS_TOKEN_TTL_SECONDS);
    return {
      ok: true,
      userId: rt.user_id,
      tokens: { accessToken, accessExpiresAt: new Date(now.getTime() + cfg.ACCESS_TOKEN_TTL_SECONDS * 1000), refreshToken, refreshExpiresAt, sessionId: rt.session_id },
    };
  });
}

export async function revokeSession(db: Database | Tx, sessionId: string, reason: string): Promise<void> {
  await db.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: reason }).where('id', '=', sessionId).where('revoked_at', 'is', null).execute();
  await db.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('session_id', '=', sessionId).where('revoked_at', 'is', null).execute();
}

export async function revokeAllUserSessions(db: Database | Tx, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  let q = db.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: reason }).where('user_id', '=', userId).where('revoked_at', 'is', null);
  if (exceptSessionId) q = q.where('id', '<>', exceptSessionId);
  const res = await q.executeTakeFirst();
  return Number(res.numUpdatedRows);
}
