/**
 * Share-portal session tokens: HMAC-signed, short-lived, bound to ONE share id. They are sent in the
 * `X-Share-Session` header (never a cookie, so they cannot ride along cross-site) and re-validated against
 * the share on every request (revocation/expiry take effect immediately).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '@ksp/core';

export const SHARE_SESSION_HEADER = 'x-share-session';
export const SHARE_SESSION_TTL_SECONDS = 30 * 60;

interface Claims {
  typ: 'share-session';
  sid: string; // share id
  exp: number;
  n: string;
}

function key(): Buffer {
  return createHmac('sha256', loadConfig().MEDIA_TOKEN_SECRET).update('ksp/share-portal/session/v1').digest();
}

export function signShareSession(shareId: string, ttlSeconds = SHARE_SESSION_TTL_SECONDS): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ typ: 'share-session', sid: shareId, exp, n: randomBytes(8).toString('base64url') } satisfies Claims)).toString('base64url');
  const mac = createHmac('sha256', key()).update(body).digest('base64url');
  return { token: `${body}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyShareSession(token: string | undefined): { shareId: string; exp: number } | null {
  if (!token || token.length > 2048) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
    if (c.typ !== 'share-session' || typeof c.sid !== 'string' || typeof c.exp !== 'number' || c.exp < Math.floor(Date.now() / 1000)) return null;
    return { shareId: c.sid, exp: c.exp };
  } catch {
    return null;
  }
}
