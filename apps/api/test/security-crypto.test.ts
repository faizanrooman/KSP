/** At-rest secret encryption (AES-256-GCM, packages/core/src/crypto.ts): tampering and tag truncation are refused;
 *  versioned keyring + re-encryption (OPS-10). */
import { afterAll, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, needsReencryption, parseDataKeyring, rotateDataEncryption } from '@ksp/core';
import { closeApp, createUser, getApp } from './helpers.js';

const key = randomBytes(32).toString('base64');
const flip = (b64: string) => { const b = Buffer.from(b64, 'base64url'); b[0]! ^= 1; return b.toString('base64url'); };

/** The pre-OPS-10 format, v1.<iv>.<tag>.<ct> without key id / AAD (what existing databases contain). */
function encryptV1(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

afterAll(closeApp);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips and records the key id', () => {
    const t = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(t.startsWith('v2.default.')).toBe(true);
    expect(decryptSecret(t, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a truncated authentication tag (SEC-05)', () => {
    const [v, id, iv, tag, ct] = encryptSecret('secret', key).split('.') as [string, string, string, string, string];
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptSecret([v, id, iv, short, ct].join('.'), key)).toThrow();
  });

  it('refuses modified ciphertext, IV, key id (AAD) or wrong key', () => {
    const ring = parseDataKeyring(`a:${key},b:${key}`, undefined);
    const [v, id, iv, tag, ct] = encryptSecret('secret', ring).split('.') as [string, string, string, string, string];
    expect(() => decryptSecret([v, id, iv, tag, flip(ct)].join('.'), ring)).toThrow();
    expect(() => decryptSecret([v, id, flip(iv), tag, ct].join('.'), ring)).toThrow();
    // Same key material under id b: the id is authenticated, so swapping it fails.
    expect(() => decryptSecret([v, 'b', iv, tag, ct].join('.'), ring)).toThrow();
    expect(() => decryptSecret([v, 'zzz', iv, tag, ct].join('.'), ring)).toThrow(/unknown data-encryption key id/);
    expect(() => decryptSecret([v, id, iv, tag, ct].join('.'), randomBytes(32).toString('base64'))).toThrow();
  });
});

describe('versioned data-encryption keyring (OPS-10)', () => {
  const k1 = randomBytes(32).toString('base64');
  const k2 = randomBytes(32).toString('base64');

  it('parses DATA_ENCRYPTION_KEYS (first = current) and keeps DATA_ENCRYPTION_KEY as decrypt-only "default"', () => {
    const r = parseDataKeyring(`k2:${k2}, k1:${k1}`, key);
    expect(r.current.id).toBe('k2');
    expect(r.keys.map((k) => k.id)).toEqual(['k2', 'k1', 'default']);
    expect(parseDataKeyring(undefined, key).current.id).toBe('default');
    expect(() => parseDataKeyring('bad', undefined)).toThrow();
    expect(() => parseDataKeyring(`a:${k1},a:${k2}`, undefined)).toThrow(/duplicate/);
    expect(() => parseDataKeyring(`default:${k1}`, k2)).toThrow();
    expect(() => parseDataKeyring(undefined, undefined)).toThrow(/required/);
  });

  it('decrypts by key id after rotation, and legacy v1 ciphertext with the legacy key', () => {
    const old = parseDataKeyring(`k1:${k1}`, undefined);
    const rotated = parseDataKeyring(`k2:${k2},k1:${k1}`, undefined);
    const t1 = encryptSecret('s1', old);
    expect(decryptSecret(t1, rotated)).toBe('s1');
    expect(needsReencryption(t1, rotated)).toBe(true);
    const t2 = encryptSecret('s2', rotated);
    expect(t2.startsWith('v2.k2.')).toBe(true);
    expect(needsReencryption(t2, rotated)).toBe(false);
    expect(() => decryptSecret(t2, old)).toThrow(/unknown data-encryption key id k2/);
    const legacy = encryptV1('s0', k1);
    expect(decryptSecret(legacy, parseDataKeyring(`k2:${k2}`, k1))).toBe('s0');
    expect(needsReencryption(legacy, rotated)).toBe(true);
  });

  it('keys:rotate-data re-encrypts MFA secrets + pending secrets to the current key, idempotently, audited', async () => {
    const app = await getApp();
    const legacyKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const before = parseDataKeyring(undefined, legacyKey);
    const after = parseDataKeyring(`r2:${newKey}`, legacyKey);
    const only = parseDataKeyring(`r2:${newKey}`, undefined);
    const users = await Promise.all([0, 1, 2].map(() => createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' })));
    await app.db.updateTable('users').set({ mfa_secret_enc: encryptV1('SECRET0', legacyKey) }).where('id', '=', users[0]!.id).execute();
    await app.db.updateTable('users').set({ mfa_secret_enc: encryptSecret('SECRET1', before), mfa_pending_secret_enc: encryptSecret('PEND1', before) }).where('id', '=', users[1]!.id).execute();
    await app.db.updateTable('users').set({ mfa_pending_secret_enc: 'v2.gone.AAAA.AAAA.AAAA' }).where('id', '=', users[2]!.id).execute();

    const r = await rotateDataEncryption(app.db, { ring: after, batchSize: 1 });
    expect(r.currentKeyId).toBe('r2');
    expect(r.failedIds).toContain(users[2]!.id);
    const rows = await app.db.selectFrom('users').select(['id', 'mfa_secret_enc', 'mfa_pending_secret_enc']).where('id', 'in', users.map((u) => u.id)).execute();
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(users[0]!.id)!.mfa_secret_enc!.startsWith('v2.r2.')).toBe(true);
    expect(decryptSecret(byId.get(users[0]!.id)!.mfa_secret_enc!, only)).toBe('SECRET0');
    expect(decryptSecret(byId.get(users[1]!.id)!.mfa_secret_enc!, only)).toBe('SECRET1');
    expect(decryptSecret(byId.get(users[1]!.id)!.mfa_pending_secret_enc!, only)).toBe('PEND1');
    expect(byId.get(users[2]!.id)!.mfa_pending_secret_enc).toBe('v2.gone.AAAA.AAAA.AAAA');

    // Idempotent: a second run leaves already-rotated rows untouched.
    await app.db.updateTable('users').set({ mfa_pending_secret_enc: null }).where('id', '=', users[2]!.id).execute();
    const snap = byId.get(users[0]!.id)!.mfa_secret_enc;
    const r2 = await rotateDataEncryption(app.db, { ring: after });
    const again = await app.db.selectFrom('users').select('mfa_secret_enc').where('id', '=', users[0]!.id).executeTakeFirstOrThrow();
    expect(again.mfa_secret_enc).toBe(snap);
    expect(r2.failedIds).not.toContain(users[2]!.id);
    const audit = await app.db.selectFrom('audit_events').select(['outcome', 'details', 'resource_id']).where('action', '=', 'KEY_ROTATED').orderBy('seq', 'desc').limit(2).execute();
    expect(audit).toHaveLength(2);
    expect(audit[0]!.resource_id).toBe('r2');
    expect(audit[1]!.outcome).toBe('FAILURE');
    expect(JSON.stringify(audit)).not.toContain(newKey);
  });
});
