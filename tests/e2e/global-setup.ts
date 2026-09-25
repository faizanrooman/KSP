/**
 * Runs once before the suite:
 *  1. checks the stack (API, web) of THIS checkout is reachable;
 *  2. resets per-run auth fixtures in the E2E database (schema owner connection):
 *     - MFA enrolment of the MFA-mandatory dev users (so every run exercises forced enrolment),
 *     - lockout counters of dev users and failed login attempts from localhost (IP throttle),
 *     - a dedicated, disposable `e2e.lockout` field officer used by the lockout test;
 *  3. writes a run id used to make names/media unique.
 * It never touches evidence, audit or custody data (those are append-only and only grow).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { MFA_USERS } from './lib/auth';
import { API_URL, BASE_URL, MIGRATION_DB_URL, STATE_DIR } from './lib/env';

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  const api = `${API_URL}/health/ready`;
  if (!(await reachable(api))) throw new Error(`API not ready at ${api}. Start it: NODE_ENV=test KSP_ENV_FILE=$PWD/.env scripts/dev/run.sh start api (see docs/E2E-TESTS.md)`);
  if (!(await reachable(`${BASE_URL}/login`))) throw new Error(`Web UI not reachable at ${BASE_URL}. Start it: scripts/dev/run.sh start web`);
  if (!MIGRATION_DB_URL) throw new Error('DATABASE_MIGRATION_URL missing from .env');
  // Iterating on single specs: E2E_REUSE=1 keeps the previous run's MFA secrets and shared state.
  if (process.env.E2E_REUSE === '1' && existsSync(resolve(STATE_DIR, 'mfa.json'))) return;

  const db = new pg.Client({ connectionString: MIGRATION_DB_URL });
  await db.connect();
  try {
    await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_recovery_codes = '{}', mfa_enrolled_at = NULL
        WHERE username = ANY($1)`,
      [MFA_USERS],
    );
    await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'e2e reset' WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [MFA_USERS]);
    await db.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE username NOT LIKE 'e2e.%' OR username = 'e2e.lockout'`);
    await db.query(`DELETE FROM login_attempts WHERE success = false AND ip IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`);
    // Disposable users (same password hash as fo.ravi, FIELD_OFFICER at the same station):
    //   e2e.lockout  — account lockout test;  e2e.pwchange — forced password change on first login.
    for (const [u, badge, mustChange] of [['e2e.lockout', 'E2E-LOCK-1', false], ['e2e.pwchange', 'E2E-PWC-1', true]] as const) {
      await db.query(
        `INSERT INTO users (username, email, full_name, badge_number, rank, home_org_unit_id, status, password_hash, password_changed_at, must_change_password)
         SELECT $1::text, $1::text || '@ksp.example.invalid', 'E2E ' || $1::text, $2, rank, home_org_unit_id, 'ACTIVE', password_hash, now(), $3
           FROM users WHERE username = 'fo.ravi'
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = EXCLUDED.must_change_password,
           status = 'ACTIVE', failed_login_count = 0, locked_until = NULL`,
        [u, badge, mustChange],
      );
      await db.query(`DELETE FROM password_history WHERE user_id = (SELECT id FROM users WHERE username = $1)`, [u]);
      await db.query(
        `INSERT INTO user_roles (user_id, role_id, org_unit_id)
         SELECT n.id, ur.role_id, ur.org_unit_id FROM users n, users o JOIN user_roles ur ON ur.user_id = o.id
          WHERE n.username = $1 AND o.username = 'fo.ravi'
         ON CONFLICT DO NOTHING`,
        [u],
      );
    }
  } finally {
    await db.end();
  }

  rmSync(resolve(STATE_DIR, 'mfa.json'), { force: true });
  rmSync(resolve(STATE_DIR, 'run.json'), { force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  writeFileSync(resolve(STATE_DIR, 'run-id'), runId);
}
