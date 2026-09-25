import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { loadConfig } from './config.js';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** URL-safe random token (default 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Numeric one-time code, e.g. external share access codes. */
export function randomDigits(len: number): string {
  let out = '';
  while (out.length < len) {
    const b = randomBytes(1)[0]!;
    if (b < 250) out += String(b % 10);
  }
  return out;
}

/** Argon2id (OWASP recommended parameters: m=19MiB, t=2, p=1). */
export const hashSecret = (plain: string): Promise<string> =>
  argonHash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function verifySecret(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain);
  } catch {
    return false;
  }
}

/** Pre-computed hash used to equalise timing when a username does not exist. */
let dummyHash: Promise<string> | undefined;
export const dummySecretHash = (): Promise<string> => (dummyHash ??= hashSecret(randomToken()));

/** AES-256-GCM encryption for secrets stored in the DB. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plain: string, keyB64 = loadConfig().DATA_ENCRYPTION_KEY): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(token: string, keyB64 = loadConfig().DATA_ENCRYPTION_KEY): string {
  const [v, iv, tag, ct] = token.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported ciphertext');
  const tagBuf = Buffer.from(tag, 'base64url');
  // Pin the full 128-bit tag: without authTagLength, truncated tags would be accepted (weaker forgery bound).
  if (tagBuf.length !== 16) throw new Error('invalid authentication tag');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Short-lived HMAC-signed tokens for media streaming/downloads (so <video>/<img>/hls.js requests work
 * without exposing bearer tokens or storage URLs). Format: base64url(json).base64url(hmac).
 */
export interface MediaTokenClaims {
  sub: string; // principal id (user id, share id or api_clients.id)
  typ: 'USER' | 'SHARE' | 'API_CLIENT';
  eid: string; // evidence id
  scope: 'stream' | 'download' | 'image' | 'export';
  sid?: string; // session id
  wm?: string; // watermark text to burn in (shares)
  exp: number; // unix seconds
  ref?: string; // extra reference (derivative id / export id)
}

export function signMediaToken(claims: Omit<MediaTokenClaims, 'exp'> & { ttlSeconds?: number }): string {
  const cfg = loadConfig();
  const { ttlSeconds, ...rest } = claims;
  const body: MediaTokenClaims = { ...rest, exp: Math.floor(Date.now() / 1000) + (ttlSeconds ?? cfg.MEDIA_TOKEN_TTL_SECONDS) };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const mac = createHmac('sha256', cfg.MEDIA_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyMediaToken(token: string): MediaTokenClaims | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', loadConfig().MEDIA_TOKEN_SECRET).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MediaTokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
