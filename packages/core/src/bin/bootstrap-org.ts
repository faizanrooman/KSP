/**
 * npm run ops:bootstrap-org -- [--units units.csv] [--users users.csv] [--dry-run] [--credentials-out creds.csv]
 * Validates everything first; --dry-run prints the plan. On import the one-time passwords of new users are written to
 * --credentials-out (default ./bootstrap-credentials-<timestamp>.csv, mode 0600) — never to the console or the log.
 * Distribute them through a secure channel and delete the file. See packages/core/src/ops/bootstrap-org.ts.
 */
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { createDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { systemActor } from '../audit.js';
import { executeBootstrap, planBootstrap } from '../ops/bootstrap-org.js';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// npm -w runs this in packages/core: resolve paths against the directory the operator ran npm from.
const here = (f: string | undefined) => (f ? resolve(process.env.INIT_CWD ?? process.cwd(), f) : undefined);
const unitsFile = here(arg('units'));
const usersFile = here(arg('users'));
if (!unitsFile && !usersFile) {
  console.error('usage: ops:bootstrap-org -- [--units units.csv] [--users users.csv] [--dry-run] [--credentials-out file]');
  process.exit(2);
}
const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL, 2);
try {
  const plan = await planBootstrap(db, { unitsCsv: unitsFile ? readFileSync(unitsFile, 'utf8') : undefined, usersCsv: usersFile ? readFileSync(usersFile, 'utf8') : undefined });
  console.log(`Units: ${plan.unitsToCreate.length} to create, ${plan.unitsExisting.length} already present`);
  console.log(`Users: ${plan.usersToCreate.length} to create, ${plan.usersExisting.length} already present${plan.usersExisting.length ? ` (${plan.usersExisting.join(', ')})` : ''}`);
  if (plan.errors.length) {
    console.error(`\n${plan.errors.length} validation error(s) — nothing was imported:`);
    for (const e of plan.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  } else if (process.argv.includes('--dry-run')) {
    console.log('\nDry run: validation passed, nothing written.');
  } else {
    const out = here(arg('credentials-out') ?? `bootstrap-credentials-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`)!;
    // Create the (new, 0600) credentials file BEFORE importing so passwords can never be lost after the commit.
    if (plan.usersToCreate.length) writeFileSync(out, 'username,one_time_password\n', { mode: 0o600, flag: 'wx' });
    let r;
    try {
      r = await executeBootstrap(db, plan, systemActor(`ops:bootstrap-org (${userInfo().username})`));
    } catch (e) {
      if (plan.usersToCreate.length) unlinkSync(out);
      throw e;
    }
    if (r.credentials.length) {
      appendFileSync(out, `${r.credentials.map((c) => `${c.username},${c.oneTimePassword}`).join('\n')}\n`);
      console.log(`\nImported ${r.unitsCreated} unit(s) and ${r.usersCreated} user(s). One-time passwords: ${out} (mode 0600 — distribute securely, then delete).`);
    } else console.log(`\nImported ${r.unitsCreated} unit(s); no new users.`);
  }
} finally {
  await db.destroy();
}
