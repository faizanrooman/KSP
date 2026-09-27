/**
 * npm run preflight [-- --service api|worker|ai-worker|all] [--json] [--no-db]
 * Evaluates the production preflight (packages/core/src/preflight.ts) against the current environment and prints every
 * violation and warning. Exit code 1 when any violation exists (whatever NODE_ENV is), so it can gate a deploy
 * pipeline or be run by hand on a staging/production host. Read-only.
 */
import { createDb, type Database } from '../db/index.js';
import { loadConfig } from '../config.js';
import { formatPreflight, runPreflight, type PreflightResult, type PreflightService } from '../preflight.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const service = (arg('service') ?? 'all') as PreflightService;
if (!['api', 'worker', 'ai-worker', 'all'].includes(service)) {
  console.error('--service must be api, worker, ai-worker or all');
  process.exit(2);
}
const useDb = !process.argv.includes('--no-db');
const cfg = loadConfig();
const services: PreflightService[] = service === 'all' ? ['api', 'worker', 'ai-worker'] : [service];
const results: PreflightResult[] = [];
for (const s of services) {
  const url = s === 'ai-worker' ? cfg.DATABASE_AI_URL : cfg.DATABASE_URL;
  let db: Database | undefined;
  if (useDb && url) db = createDb(url, 2).db;
  try {
    results.push(await runPreflight({ cfg, service: s, db }));
  } finally {
    await db?.destroy().catch(() => undefined);
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else for (const r of results) console.log(`${formatPreflight(r)}\n`);
const errors = results.reduce((n, r) => n + r.errors.length, 0);
console.log(errors ? `PREFLIGHT FAILED: ${errors} violation(s). A production deployment with this configuration refuses to start.` : 'PREFLIGHT PASSED (review the warnings above).');
process.exit(errors ? 1 : 0);
