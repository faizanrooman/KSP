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

/**
 * Versioned data-encryption keyring (OPS-10). The first key encrypts; every key can decrypt.
 * Sources: DATA_ENCRYPTION_KEYS (`id:base64,…`, first = current) and/or the legacy single DATA_ENCRYPTION_KEY
 * (id `default`; it is the current key only when DATA_ENCRYPTION_KEYS is not set).
 */
export interface DataKey { id: string; key: Buffer }
export interface DataKeyring { current: DataKey; keys: DataKey[] }

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const LEGACY_DATA_KEY_ID = 'default';

export function parseDataKeyring(keys: string | undefined, legacyKey: string | undefined): DataKeyring {
  const out: DataKey[] = [];
  for (const entry of (keys ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const id = entry.slice(0, i);
    const key = Buffer.from(entry.slice(i + 1), 'base64');
    if (i < 1 || !KEY_ID_RE.test(id) || key.length !== 32) throw new Error('DATA_ENCRYPTION_KEYS: each entry must be <id>:<32-byte base64>');
    if (out.some((k) => k.id === id)) throw new Error(`DATA_ENCRYPTION_KEYS: duplicate key id ${id}`);
    out.push({ id, key });
  }
  if (legacyKey) {
    const key = Buffer.from(legacyKey, 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes base64');
    const clash = out.find((k) => k.id === LEGACY_DATA_KEY_ID);
    if (clash && !clash.key.equals(key)) throw new Error(`DATA_ENCRYPTION_KEYS id "${LEGACY_DATA_KEY_ID}" differs from DATA_ENCRYPTION_KEY`);
    if (!clash) out.push({ id: LEGACY_DATA_KEY_ID, key });
  }
  if (!out.length) throw new Error('DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEYS is required');
  return { current: out[0]!, keys: out };
}

let cachedRing: { src: string; ring: DataKeyring } | undefined;
export function dataKeyring(): DataKeyring {
  const cfg = loadConfig();
  const src = `${cfg.DATA_ENCRYPTION_KEYS ?? ''}|${cfg.DATA_ENCRYPTION_KEY ?? ''}`;
  if (cachedRing?.src !== src) cachedRing = { src, ring: parseDataKeyring(cfg.DATA_ENCRYPTION_KEYS, cfg.DATA_ENCRYPTION_KEY) };
  return cachedRing.ring;
}

/** A raw base64 key (tests / tools) is treated as a one-key ring with id `default`. */
const toRing = (k?: string | DataKeyring): DataKeyring => (k === undefined ? dataKeyring() : typeof k === 'string' ? parseDataKeyring(undefined, k) : k);

/**
 * AES-256-GCM encryption for secrets stored in the DB. Output: v2.<keyId>.<iv>.<tag>.<ciphertext> (base64url),
 * with `v2.<keyId>` bound as GCM additional authenticated data. Legacy v1.<iv>.<tag>.<ct> still decrypts.
 */
export function encryptSecret(plain: string, keys?: string | DataKeyring): string {
  const { current } = toRing(keys);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`v2.${current.id}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v2', current.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function gcmOpen(key: Buffer, iv: string, tag: string, ct: string, aad?: string): string {
  const tagBuf = Buffer.from(tag, 'base64url');
  // Pin the full 128-bit tag: without authTagLength, truncated tags would be accepted (weaker forgery bound).
  if (tagBuf.length !== 16) throw new Error('invalid authentication tag');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function decryptSecret(token: string, keys?: string | DataKeyring): string {
  const ring = toRing(keys);
  const parts = token.split('.');
  if (parts[0] === 'v2' && parts.length === 5 && parts.every(Boolean)) {
    const [, id, iv, tag, ct] = parts as [string, string, string, string, string];
    // An explicit single key (string) is used whatever id was recorded; a ring looks the id up.
    const k = typeof keys === 'string' ? ring.current : ring.keys.find((x) => x.id === id);
    if (!k) throw new Error(`unknown data-encryption key id ${id}`);
    return gcmOpen(k.key, iv, tag, ct, `v2.${id}`);
  }
  if (parts[0] === 'v1' && parts.length === 4 && parts.every(Boolean)) {
    const [, iv, tag, ct] = parts as [string, string, string, string];
    // v1 carries no key id: it was written with the then-only DATA_ENCRYPTION_KEY. Prefer that key, then try the
    // rest of the ring (GCM authentication makes a wrong key fail — it never mis-decrypts).
    const ordered = [...ring.keys].sort((a, b) => Number(b.id === LEGACY_DATA_KEY_ID) - Number(a.id === LEGACY_DATA_KEY_ID));
    let last: unknown;
    for (const k of ordered) {
      try { return gcmOpen(k.key, iv, tag, ct); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('decryption failed');
  }
  throw new Error('unsupported ciphertext');
}

/** True when a stored ciphertext is not (yet) encrypted with the ring's current key. */
export function needsReencryption(token: string, ring: DataKeyring = dataKeyring()): boolean {
  const parts = token.split('.');
  return !(parts[0] === 'v2' && parts[1] === ring.current.id);
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
