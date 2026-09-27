/**
 * OPS-10: re-encrypt every DB column protected with the data-encryption keyring to the CURRENT key.
 * Encrypted columns (grep encryptSecret): users.mfa_secret_enc, users.mfa_pending_secret_enc.
 *
 * Idempotent (rows already on the current key are skipped), batched (keyset pagination, one short
 * transaction per batch with FOR UPDATE SKIP LOCKED) and audited (one KEY_ROTATED event per run, written
 * even when nothing had to change so operators can prove the run happened).
 */
import { sql } from 'kysely';
import { appendAudit, systemActor } from './audit.js';
import { dataKeyring, decryptSecret, encryptSecret, needsReencryption, type DataKeyring } from './crypto.js';
import type { Database } from './db/index.js';

export const ENCRYPTED_COLUMNS = [
  { table: 'users', column: 'mfa_secret_enc' },
  { table: 'users', column: 'mfa_pending_secret_enc' },
] as const;

export interface RotationResult { currentKeyId: string; scanned: number; reencrypted: number; failed: number; failedIds: string[] }

export async function rotateDataEncryption(db: Database, opts: { ring?: DataKeyring; batchSize?: number; log?: (m: string) => void } = {}): Promise<RotationResult> {
  const ring = opts.ring ?? dataKeyring();
  const batchSize = opts.batchSize ?? 200;
  const log = opts.log ?? (() => undefined);
  const res: RotationResult = { currentKeyId: ring.current.id, scanned: 0, reencrypted: 0, failed: 0, failedIds: [] };
  const prefix = `v2.${ring.current.id}.`;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const done = await db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ id: string; mfa_secret_enc: string | null; mfa_pending_secret_enc: string | null }>`
        SELECT id, mfa_secret_enc, mfa_pending_secret_enc FROM users
         WHERE id > ${after}::uuid
           AND ((mfa_secret_enc IS NOT NULL AND left(mfa_secret_enc, ${prefix.length}) <> ${prefix})
             OR (mfa_pending_secret_enc IS NOT NULL AND left(mfa_pending_secret_enc, ${prefix.length}) <> ${prefix}))
         ORDER BY id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`.execute(tx);
      for (const r of rows) {
        res.scanned += 1;
        after = r.id;
        try {
          const re = (v: string | null) => (v && needsReencryption(v, ring) ? encryptSecret(decryptSecret(v, ring), ring) : v);
          await tx.updateTable('users').set({ mfa_secret_enc: re(r.mfa_secret_enc), mfa_pending_secret_enc: re(r.mfa_pending_secret_enc) }).where('id', '=', r.id).execute();
          res.reencrypted += 1;
        } catch {
          // Unknown key id / corrupted ciphertext: leave the row, report it (the user must re-enrol MFA).
          res.failed += 1;
          if (res.failedIds.length < 100) res.failedIds.push(r.id);
        }
      }
      return rows.length < batchSize;
    });
    log(`re-encrypted ${res.reencrypted} row(s) so far`);
    if (done) break;
  }
  await appendAudit(db, systemActor('keys:rotate-data'), {
    action: 'KEY_ROTATED',
    outcome: res.failed ? 'FAILURE' : 'SUCCESS',
    resourceType: 'data_encryption_key',
    resourceId: ring.current.id,
    details: { currentKeyId: ring.current.id, keyIds: ring.keys.map((k) => k.id), columns: ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`), scanned: res.scanned, reencrypted: res.reencrypted, failed: res.failed, failedUserIds: res.failedIds },
  });
  return res;
}
