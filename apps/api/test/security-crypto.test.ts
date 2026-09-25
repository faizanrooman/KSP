/** At-rest secret encryption (AES-256-GCM, packages/core/src/crypto.ts): tampering and tag truncation are refused. */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@ksp/core';

const key = randomBytes(32).toString('base64');

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('JBSWY3DPEHPK3PXP', key), key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a truncated authentication tag (SEC-05)', () => {
    const [v, iv, tag, ct] = encryptSecret('secret', key).split('.') as [string, string, string, string];
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptSecret([v, iv, short, ct].join('.'), key)).toThrow();
  });

  it('refuses modified ciphertext, IV or wrong key', () => {
    const [v, iv, tag, ct] = encryptSecret('secret', key).split('.') as [string, string, string, string];
    const flip = (b64: string) => { const b = Buffer.from(b64, 'base64url'); b[0]! ^= 1; return b.toString('base64url'); };
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join('.'), key)).toThrow();
    expect(() => decryptSecret([v, flip(iv), tag, ct].join('.'), key)).toThrow();
    expect(() => decryptSecret([v, iv, tag, ct].join('.'), randomBytes(32).toString('base64'))).toThrow();
  });
});
