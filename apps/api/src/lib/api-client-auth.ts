/**
 * API-client Basic-auth secret verification (SEC-R8 / FN-15).
 *  - Unknown client ids still run an argon2 verification against a dummy hash → uniform timing (no id enumeration).
 *  - Positive verifications are cached in memory for ≤ 60 s, keyed by sha256(client_id + ':' + secret), so an
 *    integration calling many times per second does not pay argon2 (≈ 12 ms, 19 MiB) on every request.
 *    A cache hit is honoured only if the entry's stored secret_hash equals the CURRENT row's secret_hash — the
 *    row is still loaded on every request (revoked_at / expires_at / allowed_ips checked each time), so a rotated
 *    secret invalidates cached entries on every replica immediately; revoke/rotate also evict locally.
 */
import { createHash } from 'node:crypto';
import { dummySecretHash, verifySecret } from '@ksp/core';

export const API_CLIENT_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, { clientRowId: string; secretHash: string; expires: number }>();

const keyOf = (clientId: string, secret: string) => createHash('sha256').update(`${clientId}:${secret}`).digest('hex');

export async function verifyApiClientSecret(clientId: string, secret: string, client: { id: string; secret_hash: string } | undefined): Promise<boolean> {
  if (!client) {
    await verifySecret(await dummySecretHash(), secret);
    return false;
  }
  const k = keyOf(clientId, secret);
  const hit = cache.get(k);
  const now = Date.now();
  if (hit && hit.expires > now && hit.clientRowId === client.id && hit.secretHash === client.secret_hash) return true;
  if (hit) cache.delete(k);
  const ok = await verifySecret(client.secret_hash, secret);
  if (ok) {
    if (cache.size >= MAX_ENTRIES) {
      for (const [key, v] of cache) if (v.expires <= now) cache.delete(key);
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    cache.set(k, { clientRowId: client.id, secretHash: client.secret_hash, expires: now + API_CLIENT_CACHE_TTL_MS });
  }
  return ok;
}

/** Evict every cached verification of one api_clients row (revoke / rotate / update). */
export function invalidateApiClientCache(clientRowId: string): void {
  for (const [k, v] of cache) if (v.clientRowId === clientRowId) cache.delete(k);
}

/** Test hook. */
export const apiClientCacheSize = (): number => cache.size;
