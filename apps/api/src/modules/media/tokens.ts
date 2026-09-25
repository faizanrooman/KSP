/**
 * Media token issuance/verification for browser media elements (<video>, <img>, hls.js), which cannot send
 * bearer headers. Tokens are short-lived HMAC claims (core signMediaToken) bound to ONE evidence item and ONE
 * scope. USER tokens are additionally bound to the issuing session: every request re-checks that the session
 * is still active (revoked / expired sessions stop streaming immediately).
 */
import type { FastifyRequest } from 'fastify';
import { signMediaToken, verifyMediaToken, type AuditActor, type Database, type MediaTokenClaims } from '@ksp/core';
import { API_PREFIX } from '@ksp/shared';
import { AppError, forbidden, unauthenticated } from '../../lib/errors.js';
import type { Principal } from '../../lib/principal.js';

export const IMAGE_TOKEN_TTL_SECONDS = 900;
export const DOWNLOAD_TOKEN_TTL_SECONDS = 60;

export function issueUserToken(p: Principal, evidenceId: string, scope: MediaTokenClaims['scope'], opts: { ttlSeconds?: number; ref?: string } = {}): string {
  if (!p.userId || !p.sessionId) throw forbidden('Media access requires an interactive user session');
  return signMediaToken({ typ: 'USER', sub: p.userId, sid: p.sessionId, eid: evidenceId, scope, ref: opts.ref, ttlSeconds: opts.ttlSeconds });
}

export function tokenExpiry(token: string): string {
  const claims = verifyMediaToken(token);
  return new Date((claims?.exp ?? 0) * 1000).toISOString();
}

export const streamUrl = (evidenceId: string, rel: string, token: string) => `${API_PREFIX}/media/stream/${evidenceId}/${rel}?t=${encodeURIComponent(token)}`;
export const imageUrl = (derivativeId: string, token: string) => `${API_PREFIX}/media/image/${derivativeId}?t=${encodeURIComponent(token)}`;

export interface TokenContext {
  claims: MediaTokenClaims;
  actor: AuditActor;
  /** For SHARE tokens: whether the share allows downloads. */
  shareAllowsDownload: boolean;
}

/**
 * Authenticate a media request. 401 = missing/invalid/expired token or dead session/share;
 * 403 = valid token presented for a different evidence item, scope or reference.
 */
export async function authenticateMediaToken(
  db: Database,
  req: FastifyRequest,
  token: string | undefined,
  expect: { evidenceId?: string; scope: MediaTokenClaims['scope']; ref?: string },
): Promise<TokenContext> {
  if (!token) throw unauthenticated('Media token required');
  const claims = verifyMediaToken(token);
  if (!claims) throw unauthenticated('Media token invalid or expired');
  if (claims.scope !== expect.scope) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
  if (expect.evidenceId && claims.eid !== expect.evidenceId) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
  if (expect.ref !== undefined && claims.ref !== expect.ref) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
  const base = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
  const now = new Date();
  if (claims.typ === 'USER') {
    if (!claims.sid) throw unauthenticated('Media token invalid or expired');
    const s = await db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select(['s.id', 'u.username', 'u.status'])
      .where('s.id', '=', claims.sid)
      .where('s.user_id', '=', claims.sub)
      .where('s.revoked_at', 'is', null)
      .where('s.idle_expires_at', '>', now)
      .where('s.absolute_expires_at', '>', now)
      .executeTakeFirst();
    if (!s || s.status !== 'ACTIVE') throw unauthenticated('Session no longer active');
    return { claims, actor: { type: 'USER', id: claims.sub, name: s.username, sessionId: claims.sid, ...base }, shareAllowsDownload: false };
  }
  if (claims.typ === 'SHARE') {
    const share = await db
      .selectFrom('shares as sh')
      .innerJoin('share_items as si', 'si.share_id', 'sh.id')
      .select(['sh.id', 'sh.allow_download', 'sh.recipient_name'])
      .where('sh.id', '=', claims.sub)
      .where('si.evidence_id', '=', claims.eid)
      .where('sh.status', '=', 'ACTIVE')
      .where('sh.expires_at', '>', now)
      .executeTakeFirst();
    if (!share) throw unauthenticated('Share no longer active');
    return { claims, actor: { type: 'EXTERNAL_RECIPIENT', id: share.id, name: share.recipient_name ?? null, ...base }, shareAllowsDownload: share.allow_download };
  }
  throw unauthenticated('Media token invalid or expired');
}
