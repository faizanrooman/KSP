/**
 * CLI: delete DR-store copies of DISPOSED evidence now (same logic as the dr.dispose-sweep cron).
 *   npm run -w @ksp/worker dr:dispose-sweep [-- --limit N]
 * Needs DATABASE_URL (ksp_app) and DR_S3_* (see packages/core/src/dr.ts). Prints a JSON summary; exit 1 on failures.
 */
import { createDb, loadConfig } from '@ksp/core';
import { runDrDisposeSweep } from '../jobs/dr/sweep.js';

const i = process.argv.indexOf('--limit');
const limit = i > 0 ? Number(process.argv[i + 1]) : undefined;
const { db } = createDb(loadConfig().DATABASE_URL, 2);
try {
  const r = await runDrDisposeSweep(db, { limit });
  console.log(JSON.stringify(r, null, 2));
  if (!r.configured) {
    console.error('dr-dispose-sweep: DR_S3_ENDPOINT / DR_S3_ACCESS_KEY / DR_S3_SECRET_KEY are not set');
    process.exitCode = 2;
  } else if (r.failed) process.exitCode = 1;
} finally {
  await db.destroy();
}
