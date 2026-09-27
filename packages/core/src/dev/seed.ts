/**
 * Seeding.
 *   npm run db:seed                 -> reference data + DEV fixtures (org units, one user per role; password printed)
 *   npm run db:seed -- --production -> reference data + root org + ONE administrator with a random one-time password
 *                                      (must change password and enrol MFA on first login). No fixtures.
 * Idempotent: existing rows are left untouched (roles' permissions are NOT overwritten once edited by admins).
 */
import { sql } from 'kysely';
import { ALERT_RULE_CODES, DEFAULT_ROLES, DEFAULT_SETTINGS, SETTING_KEYS } from '@ksp/shared';
import { createDb, type Database } from '../db/index.js';
import { hashSecret, randomToken } from '../crypto.js';
import { appendAudit, systemActor } from '../audit.js';
import { storage } from '../storage.js';

const production = process.argv.includes('--production');
export const DEV_PASSWORD = process.env.KSP_DEV_PASSWORD ?? 'Ksp@Dev-Passw0rd!';

interface OrgSeed {
  code: string;
  name: string;
  type: string;
  parent?: string;
  lat?: number;
  lon?: number;
}

export const ORG: OrgSeed[] = [
  { code: 'ksp', name: 'Karnataka State Police', type: 'STATE', lat: 12.9716, lon: 77.5946 },
  { code: 'blr_city', name: 'Bengaluru City Police Commissionerate', type: 'COMMISSIONERATE', parent: 'ksp' },
  { code: 'blr_central', name: 'Central Division', type: 'DISTRICT', parent: 'blr_city' },
  { code: 'ps_cubbonpark', name: 'Cubbon Park Police Station', type: 'STATION', parent: 'blr_central', lat: 12.9763, lon: 77.5929 },
  { code: 'ps_highgrounds', name: 'High Grounds Police Station', type: 'STATION', parent: 'blr_central', lat: 12.9906, lon: 77.5847 },
  { code: 'blr_east', name: 'East Division', type: 'DISTRICT', parent: 'blr_city' },
  { code: 'ps_indiranagar', name: 'Indiranagar Police Station', type: 'STATION', parent: 'blr_east', lat: 12.9784, lon: 77.6408 },
  { code: 'southern_range', name: 'Southern Range', type: 'RANGE', parent: 'ksp' },
  { code: 'mysuru_dist', name: 'Mysuru District Police', type: 'DISTRICT', parent: 'southern_range' },
  { code: 'ps_nazarbad', name: 'Nazarbad Police Station', type: 'STATION', parent: 'mysuru_dist', lat: 12.3052, lon: 76.6647 },
];

export const DEV_USERS: Array<{ username: string; name: string; badge: string; rank: string; org: string; role: string; roleAt?: string }> = [
  { username: 'admin', name: 'System Administrator', badge: 'ADM-0001', rank: 'Admin', org: 'ksp', role: 'SYSTEM_ADMINISTRATOR' },
  { username: 'fo.ravi', name: 'Ravi Kumar', badge: 'KSP-FO-1001', rank: 'Police Constable', org: 'ps_cubbonpark', role: 'FIELD_OFFICER' },
  { username: 'op.cubbon', name: 'Station Operator Cubbon Park', badge: 'KSP-OP-2001', rank: 'Head Constable', org: 'ps_cubbonpark', role: 'STATION_OPERATOR' },
  { username: 'io.meera', name: 'Meera Rao', badge: 'KSP-IO-3001', rank: 'Sub-Inspector', org: 'ps_cubbonpark', role: 'INVESTIGATING_OFFICER' },
  { username: 'io.arjun', name: 'Arjun Shetty', badge: 'KSP-IO-3002', rank: 'Sub-Inspector', org: 'ps_indiranagar', role: 'INVESTIGATING_OFFICER' },
  { username: 'sup.kavya', name: 'Kavya Hegde', badge: 'KSP-SUP-4001', rank: 'Inspector', org: 'blr_central', role: 'SUPERVISOR' },
  { username: 'fa.naveen', name: 'Naveen Gowda', badge: 'KSP-FA-5001', rank: 'Scientific Officer', org: 'blr_city', role: 'FORENSIC_ANALYST' },
  { username: 'ec.latha', name: 'Latha Murthy', badge: 'KSP-EC-6001', rank: 'Assistant Sub-Inspector', org: 'blr_city', role: 'EVIDENCE_CUSTODIAN' },
  { username: 'aud.suresh', name: 'Suresh Patil', badge: 'KSP-AUD-7001', rank: 'Deputy Superintendent', org: 'ksp', role: 'AUDITOR' },
  { username: 'io.mysuru', name: 'Deepa Nayak', badge: 'KSP-IO-3101', rank: 'Sub-Inspector', org: 'ps_nazarbad', role: 'INVESTIGATING_OFFICER' },
];

const ALERT_RULE_DEFAULTS: Record<(typeof ALERT_RULE_CODES)[number], { name: string; severity: string; config: object }> = {
  UPLOAD_FAILED: { name: 'Failed uploads', severity: 'WARNING', config: {} },
  PROCESSING_FAILED: { name: 'Media processing errors', severity: 'WARNING', config: {} },
  STORAGE_THRESHOLD: { name: 'Storage utilisation threshold', severity: 'CRITICAL', config: {} },
  INTEGRITY_FAILURE: { name: 'Evidence integrity (hash) failure', severity: 'CRITICAL', config: {} },
  EXCESSIVE_DOWNLOADS: { name: 'Excessive downloads/exports by a user', severity: 'WARNING', config: { perHour: 20 } },
  AUTH_BRUTE_FORCE: { name: 'Brute-force login attempts', severity: 'CRITICAL', config: { failuresPer15Min: 20 } },
  AUDIT_CHAIN_BROKEN: { name: 'Audit ledger chain verification failure', severity: 'CRITICAL', config: {} },
  POLICY_VIOLATION: { name: 'Access policy violations (denied evidence access)', severity: 'WARNING', config: { deniedPer15Min: 10 } },
  AI_FAILURE: { name: 'AI analysis failures', severity: 'WARNING', config: {} },
  QUEUE_BACKLOG: { name: 'Processing queue backlog', severity: 'WARNING', config: { maxQueued: 500, maxAgeMinutes: 60 } },
};

export async function seedReference(db: Database) {
  for (const r of DEFAULT_ROLES) {
    await db
      .insertInto('roles')
      .values({ code: r.code, name: r.name, description: r.description, permissions: r.permissions, is_system: true })
      .onConflict((oc) => oc.column('code').doNothing())
      .execute();
  }
  for (const key of SETTING_KEYS) {
    await db
      .insertInto('system_settings')
      .values({ key, value: JSON.stringify(DEFAULT_SETTINGS[key]) })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
  }
  const policies = [
    { code: 'default', name: 'Default (7 years)', description: 'Default retention for uncategorised body-worn camera footage.', retention_days: 2555, archive_after_days: 180, long_term_after_days: 730, is_default: true },
    { code: 'non_evidentiary', name: 'Non-evidentiary (1 year)', description: 'Routine footage with no incident or case linkage.', retention_days: 365, archive_after_days: 90, long_term_after_days: null, is_default: false },
    { code: 'serious_crime', name: 'Serious crime (indefinite)', description: 'Footage linked to heinous offences; retained until court disposal order.', retention_days: null, archive_after_days: 365, long_term_after_days: 1825, is_default: false },
  ];
  for (const p of policies) {
    await db.insertInto('retention_policies').values(p).onConflict((oc) => oc.column('code').doNothing()).execute();
  }
  for (const [code, r] of Object.entries(ALERT_RULE_DEFAULTS)) {
    await db
      .insertInto('alert_rules')
      .values({ code, name: r.name, severity: r.severity, config: JSON.stringify(r.config) })
      .onConflict((oc) => oc.column('code').doNothing())
      .execute();
  }
}

export async function seedOrg(db: Database, units: OrgSeed[]) {
  for (const u of units) {
    const parent = u.parent ? await db.selectFrom('org_units').select(['id', 'path']).where('code', '=', u.parent).executeTakeFirstOrThrow() : null;
    await db
      .insertInto('org_units')
      .values({
        code: u.code,
        name: u.name,
        unit_type: u.type,
        parent_id: parent?.id ?? null,
        path: parent ? `${parent.path}.${u.code}` : u.code,
        latitude: u.lat ?? null,
        longitude: u.lon ?? null,
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .execute();
  }
}

export async function createUser(
  db: Database,
  u: { username: string; name: string; badge: string; rank: string; org: string; role: string },
  password: string,
  mustChange: boolean,
) {
  const exists = await db.selectFrom('users').select('id').where('username', '=', u.username).executeTakeFirst();
  if (exists) return false;
  const org = await db.selectFrom('org_units').select('id').where('code', '=', u.org).executeTakeFirstOrThrow();
  const role = await db.selectFrom('roles').select('id').where('code', '=', u.role).executeTakeFirstOrThrow();
  const hash = await hashSecret(password);
  await db.transaction().execute(async (tx) => {
    const user = await tx
      .insertInto('users')
      .values({
        username: u.username,
        full_name: u.name,
        badge_number: u.badge,
        rank: u.rank,
        email: `${u.username}@ksp.example.invalid`,
        home_org_unit_id: org.id,
        password_hash: hash,
        password_changed_at: new Date(),
        must_change_password: mustChange,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('password_history').values({ user_id: user.id, password_hash: hash }).execute();
    await tx.insertInto('user_roles').values({ user_id: user.id, role_id: role.id, org_unit_id: org.id }).execute();
    await appendAudit(tx, systemActor('seed'), { action: 'USER_CREATED', resourceType: 'user', resourceId: user.id, details: { username: u.username, role: u.role, seeded: true } });
  });
  return true;
}

async function main() {
  const { db, pool } = createDb(process.env.DATABASE_URL);
  try {
    await storage().ensureBuckets();
    await seedReference(db);
    if (production) {
      const r = await seedProduction(db);
      for (const w of r.warnings) console.warn(`WARNING: ${w}`);
      console.log(r.password ? `Initial administrator '${r.username}' created. One-time password (change on first login, MFA enrolment required):\n  ${r.password}` : 'Administrator already exists; nothing changed.');
    } else {
      await seedOrg(db, ORG);
      let n = 0;
      for (const u of DEV_USERS) if (await createUser(db, u, DEV_PASSWORD, false)) n++;
      await sql`SELECT 1`.execute(db);
      console.log(`Seeded reference data, ${ORG.length} org units, ${n} new dev users. Dev password for all dev users: ${DEV_PASSWORD}`);
    }
  } finally {
    await db.destroy();
    await pool.end().catch(() => undefined);
  }
}

/**
 * Production first run: reference data, the root org unit only, and ONE administrator with a random one-time password
 * (must change on first login; MFA enrolment is mandatory because sessionPolicy.requireMfaForRoles always contains
 * SYSTEM_ADMINISTRATOR after this). No dev users, no fixture org units, no integration systems. Idempotent.
 */
export async function seedProduction(db: Database): Promise<{ username: string; password: string | null; warnings: string[] }> {
  await seedReference(db);
  await seedOrg(db, [ORG[0]!]);
  const policy = await db.selectFrom('system_settings').select('value').where('key', '=', 'sessionPolicy').executeTakeFirst();
  const v = { ...DEFAULT_SETTINGS.sessionPolicy, ...((policy?.value as object | undefined) ?? {}) };
  if (!v.requireMfaForRoles.includes('SYSTEM_ADMINISTRATOR')) {
    const next = { ...v, requireMfaForRoles: [...v.requireMfaForRoles, 'SYSTEM_ADMINISTRATOR'] };
    await db.updateTable('system_settings').set({ value: JSON.stringify(next), updated_at: new Date() }).where('key', '=', 'sessionPolicy').execute();
  }
  const warnings: string[] = [];
  const dev = await db.selectFrom('users').select('username').where('username', 'in', DEV_USERS.filter((u) => u.username !== 'admin').map((u) => u.username)).execute();
  if (dev.length) warnings.push(`development users exist in this database (${dev.map((d) => d.username).join(', ')}); run npm run ops:purge-demo-data or use a fresh database`);
  const pw = `${randomToken(12)}!Aa1`;
  const created = await createUser(db, { username: 'admin', name: 'System Administrator', badge: 'ADM-0001', rank: 'Admin', org: 'ksp', role: 'SYSTEM_ADMINISTRATOR' }, pw, true);
  return { username: 'admin', password: created ? pw : null, warnings };
}

export async function seedDev(db: Database): Promise<number> {
  await seedReference(db);
  await seedOrg(db, ORG);
  let n = 0;
  for (const u of DEV_USERS) if (await createUser(db, u, DEV_PASSWORD, false)) n++;
  return n;
}

if (process.env.KSP_SEED_CLI === '1') {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
