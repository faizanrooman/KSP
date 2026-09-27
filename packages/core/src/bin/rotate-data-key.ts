/**
 * Re-encrypt all DB secrets to the current data-encryption key (first entry of DATA_ENCRYPTION_KEYS).
 *   npm run keys:rotate-data -w @ksp/core [-- --batch 200]
 * Exit 1 when any row could not be decrypted with the configured keyring.
 */
import { createDb } from '../db/index.js';
import { rotateDataEncryption } from '../key-rotation.js';

const i = process.argv.indexOf('--batch');
const batchSize = i > 0 ? Number(process.argv[i + 1]) : 200;
const { db } = createDb(undefined, 2);
rotateDataEncryption(db, { batchSize, log: (m) => console.log(m) })
  .then(async (r) => {
    console.log(JSON.stringify(r));
    await db.destroy();
    process.exit(r.failed ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.destroy();
    process.exit(1);
  });
