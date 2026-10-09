#!/usr/bin/env node
/**
 * Demo/dev helper for two-step verification on the seeded accounts.
 *
 *   node scripts/dev/mfa.mjs code  <username>   print the current 6-digit code for an account the E2E suite enrolled
 *                                                (secrets in tests/e2e/.state/mfa.json; admin, sup.kavya, aud.suresh, ec.latha)
 *   node scripts/dev/mfa.mjs reset <username>…  clear the enrolment so the next sign-in shows the QR code again
 *                                                (enrol your own authenticator app); active sessions are signed out
 *
 * Development only: uses the schema-owner connection from .env (DATABASE_MIGRATION_URL). In production an administrator
 * resets MFA from Users → user → "Reset MFA" (audited); there is no secret file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(resolve(ROOT, 'tests/e2e/package.json'));
const [action, ...users] = process.argv.slice(2);
const usage = () => { console.error('usage: node scripts/dev/mfa.mjs code <username> | reset <username>…'); process.exit(2); };
if (!action || !users.length) usage();

if (action === 'code') {
  const file = resolve(ROOT, 'tests/e2e/.state/mfa.json');
  if (!existsSync(file)) { console.error(`no recorded secrets (${file}); the account was not enrolled by the E2E suite — use "reset" and enrol your own app`); process.exit(1); }
  const { authenticator } = require('otplib');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  for (const u of users) {
    const e = state[u];
    if (!e) { console.error(`${u}: no recorded secret (enrolled with a real authenticator, or never enrolled) — use "reset"`); process.exitCode = 1; continue; }
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    console.log(`${u}: ${authenticator.generate(e.secret)}   (valid for ${left} s)`);
  }
} else if (action === 'reset') {
  const env = Object.fromEntries(readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const pg = require('pg');
  const db = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
  await db.connect();
  try {
    const r = await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_recovery_codes = '{}', mfa_enrolled_at = NULL
        WHERE username = ANY($1) RETURNING username`, [users]);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'dev mfa reset' WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [users]);
    const done = r.rows.map((x) => x.username);
    for (const u of users) console.log(done.includes(u) ? `${u}: MFA reset — next sign-in shows the QR code (scan it with Google/Microsoft Authenticator)` : `${u}: no such user`);
  } finally { await db.end(); }
} else usage();
