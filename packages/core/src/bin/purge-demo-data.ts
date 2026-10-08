/**
 * npm run ops:purge-demo-data [-- --execute] [--i-understand] [--json]
 * Dry-run by default. See packages/core/src/ops/purge-demo.ts for exactly what is (and is never) changed.
 */
import { userInfo } from 'node:os';
import { createDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { systemActor } from '../audit.js';
import { executeDemoPurge, planDemoPurge } from '../ops/purge-demo.js';

const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL, 2);
const execute = process.argv.includes('--execute');
try {
  const plan = await planDemoPurge(db, cfg, { iUnderstand: process.argv.includes('--i-understand') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`Demo-data purge plan (KSP_ENVIRONMENT=${plan.environment}):`);
    console.log(`  disable dev users:          ${plan.usersToDisable.join(', ') || '-'}`);
    console.log(`  reset 'admin' dev password: ${plan.adminPasswordReset ? 'yes (new one-time password)' : 'no'}`);
    console.log(`  deactivate demo org units:  ${plan.orgUnitsToDeactivate.join(', ') || '-'}`);
    console.log(`  disable fixture systems:    ${plan.fixtureSystemsToDisable.join(', ') || '-'}`);
    console.log(`  demo evidence retained:     ${plan.demoEvidence} item(s) (immutable; rebuild the database for a pristine one)`);
    console.log(`  evidence in real units:     ${plan.realEvidence.count}`);
  }
  if (plan.refused) {
    console.error(`REFUSED: ${plan.refused}`);
    process.exitCode = 1;
  } else if (!execute) {
    console.log('\nDry run only. Re-run with --execute to apply.');
  } else {
    const r = await executeDemoPurge(db, plan, systemActor(`ops:purge-demo-data (${userInfo().username})`));
    console.log('\nPurge applied (audit event DEMO_DATA_PURGED).');
    if (r.adminOneTimePassword) console.log(`New one-time password for 'admin' (change at first login):\n  ${r.adminOneTimePassword}`);
  }
} finally {
  await db.destroy();
}
