/**
 * ops:bootstrap-org — import the real organisation hierarchy and initial users from CSV (first run / go-live).
 *
 *   units.csv  code,name,type,parent,lat,lon           (parent = code of a unit in the file or already in the DB)
 *   users.csv  username,name,badge,rank,email,unit,role (unit = org unit code; role = role code, granted at that unit)
 *
 * Everything is validated before anything is written (unknown columns, duplicates, codes, parents/cycles, unit types,
 * coordinates, usernames, e-mails, roles, existing rows); --dry-run stops there. Units already present with the same
 * code are left unchanged and reported (idempotent re-runs); users that already exist are skipped. New users get a
 * random one-time password, must change it at first login, and MFA is enforced by role policy; the passwords are
 * returned to the caller (the CLI writes them to a 0600 file) and never logged or audited. One transaction:
 * ORG_UNIT_CREATED / USER_CREATED per row plus ORG_BOOTSTRAP_IMPORTED.
 */
import type { Database } from '../db/index.js';
import { hashSecret, randomToken } from '../crypto.js';
import { appendAudit, type AuditActor } from '../audit.js';

export const UNIT_TYPES = ['STATE', 'ZONE', 'RANGE', 'COMMISSIONERATE', 'DISTRICT', 'SUBDIVISION', 'CIRCLE', 'STATION', 'UNIT'] as const;
const UNIT_COLS = ['code', 'name', 'type', 'parent', 'lat', 'lon'];
const USER_COLS = ['username', 'name', 'badge', 'rank', 'email', 'unit', 'role'];

/** RFC 4180 CSV (quoted fields, "" escapes, CRLF/LF). Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // UTF-8 BOM from spreadsheet exports
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function records(text: string, cols: string[], what: string, errors: string[]): Array<Record<string, string> & { line: number }> {
  const rows = parseCsv(text);
  if (!rows.length) { errors.push(`${what}: empty file`); return []; }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const missing = cols.filter((c) => !header.includes(c));
  const extra = header.filter((h) => !cols.includes(h));
  if (missing.length) errors.push(`${what}: missing column(s) ${missing.join(', ')}`);
  if (extra.length) errors.push(`${what}: unknown column(s) ${extra.join(', ')}`);
  if (missing.length) return [];
  return rows.slice(1).map((r, i) => ({ ...Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])), line: i + 2 }) as Record<string, string> & { line: number });
}

export interface UnitRow { code: string; name: string; type: string; parent: string | null; lat: number | null; lon: number | null }
export interface UserRow { username: string; name: string; badge: string | null; rank: string | null; email: string | null; unit: string; role: string }
export interface BootstrapPlan {
  errors: string[];
  unitsToCreate: UnitRow[];
  unitsExisting: string[];
  usersToCreate: UserRow[];
  usersExisting: string[];
}

export async function planBootstrap(db: Database, input: { unitsCsv?: string; usersCsv?: string }): Promise<BootstrapPlan> {
  const errors: string[] = [];
  const units: UnitRow[] = [];
  const unitsExisting: string[] = [];
  const existingUnits = new Map((await db.selectFrom('org_units').select(['code', 'id']).execute()).map((u) => [u.code, u.id]));
  if (input.unitsCsv !== undefined) {
    const seen = new Set<string>();
    for (const r of records(input.unitsCsv, UNIT_COLS, 'units.csv', errors)) {
      const at = `units.csv line ${r.line}`;
      const code = r.code!.toLowerCase();
      if (!/^[a-z0-9_]{2,40}$/.test(code)) errors.push(`${at}: code '${r.code}' must be 2-40 of a-z 0-9 _`);
      if (seen.has(code)) errors.push(`${at}: duplicate code '${code}'`);
      seen.add(code);
      if (!r.name || r.name.length > 200) errors.push(`${at}: name is required (max 200 characters)`);
      const type = r.type!.toUpperCase();
      if (!(UNIT_TYPES as readonly string[]).includes(type)) errors.push(`${at}: type '${r.type}' must be one of ${UNIT_TYPES.join(', ')}`);
      const num = (v: string, min: number, max: number, f: string) => {
        if (v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${at}: ${f} '${v}' must be a number between ${min} and ${max}`); return null; }
        return n;
      };
      const lat = num(r.lat!, -90, 90, 'lat');
      const lon = num(r.lon!, -180, 180, 'lon');
      if ((lat === null) !== (lon === null)) errors.push(`${at}: give both lat and lon or neither`);
      const row: UnitRow = { code, name: r.name!, type, parent: r.parent ? r.parent.toLowerCase() : null, lat, lon };
      if (existingUnits.has(code)) unitsExisting.push(code);
      else units.push(row);
    }
    // Parents: in the file (earlier or later) or in the DB; no cycles; exactly one root overall.
    const inFile = new Map(units.map((u) => [u.code, u]));
    for (const u of units) {
      if (!u.parent) {
        if (existingUnits.size > 0) errors.push(`units.csv: unit '${u.code}' has no parent but the database already has a root unit`);
        continue;
      }
      if (u.parent === u.code) errors.push(`units.csv: unit '${u.code}' is its own parent`);
      else if (!inFile.has(u.parent) && !existingUnits.has(u.parent)) errors.push(`units.csv: parent '${u.parent}' of '${u.code}' not found in the file or the database`);
    }
    if (existingUnits.size === 0 && units.filter((u) => !u.parent).length !== 1) errors.push('units.csv: an empty database needs exactly one root unit (empty parent)');
    for (const u of units) {
      const path = new Set<string>([u.code]);
      let p = u.parent;
      while (p && inFile.has(p)) {
        if (path.has(p)) { errors.push(`units.csv: parent cycle through '${u.code}'`); break; }
        path.add(p);
        p = inFile.get(p)!.parent;
      }
    }
  }
  const unitCodes = new Set([...existingUnits.keys(), ...units.map((u) => u.code)]);
  const users: UserRow[] = [];
  const usersExisting: string[] = [];
  if (input.usersCsv !== undefined) {
    const roles = new Set((await db.selectFrom('roles').select('code').execute()).map((r) => r.code));
    const existing = await db.selectFrom('users').select(['username', 'badge_number', 'email']).execute();
    const exU = new Set(existing.map((e) => e.username.toLowerCase()));
    const exB = new Set(existing.map((e) => e.badge_number).filter(Boolean) as string[]);
    const exE = new Set(existing.map((e) => e.email?.toLowerCase()).filter(Boolean) as string[]);
    const seenU = new Set<string>();
    const seenB = new Set<string>();
    const seenE = new Set<string>();
    for (const r of records(input.usersCsv, USER_COLS, 'users.csv', errors)) {
      const at = `users.csv line ${r.line}`;
      const username = r.username!.toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) errors.push(`${at}: username '${r.username}' must be 3-64 of a-z 0-9 . _ - (starting with a letter or digit)`);
      if (seenU.has(username)) errors.push(`${at}: duplicate username '${username}'`);
      seenU.add(username);
      if (!r.name || r.name.length > 200) errors.push(`${at}: name is required (max 200 characters)`);
      const email = r.email ? r.email.toLowerCase() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`${at}: invalid e-mail '${r.email}'`);
      if (email && (seenE.has(email) || (exE.has(email) && !exU.has(username)))) errors.push(`${at}: e-mail '${email}' is already used`);
      if (email) seenE.add(email);
      const badge = r.badge || null;
      if (badge && (seenB.has(badge) || (exB.has(badge) && !exU.has(username)))) errors.push(`${at}: badge '${badge}' is already used`);
      if (badge) seenB.add(badge);
      const unit = r.unit!.toLowerCase();
      if (!unitCodes.has(unit)) errors.push(`${at}: unit '${r.unit}' not found (units.csv or database)`);
      const role = r.role!.toUpperCase();
      if (!roles.has(role)) errors.push(`${at}: unknown role '${r.role}'`);
      const row: UserRow = { username, name: r.name!, badge, rank: r.rank || null, email, unit, role };
      if (exU.has(username)) usersExisting.push(username);
      else users.push(row);
    }
  }
  return { errors, unitsToCreate: units, unitsExisting, usersToCreate: users, usersExisting };
}

export interface BootstrapResult { unitsCreated: number; usersCreated: number; credentials: Array<{ username: string; oneTimePassword: string }> }

export async function executeBootstrap(db: Database, plan: BootstrapPlan, actor: AuditActor): Promise<BootstrapResult> {
  if (plan.errors.length) throw new Error(`bootstrap refused: ${plan.errors.length} validation error(s)`);
  const credentials: BootstrapResult['credentials'] = [];
  const hashed = await Promise.all(plan.usersToCreate.map(async (u) => {
    const pw = `${randomToken(12)}!Aa1`;
    credentials.push({ username: u.username, oneTimePassword: pw });
    return { u, hash: await hashSecret(pw) };
  }));
  await db.transaction().execute(async (tx) => {
    // Insert parents before children (the file may list them in any order).
    const pending = [...plan.unitsToCreate];
    while (pending.length) {
      const idx = pending.findIndex((u) => !u.parent || !pending.some((p) => p.code === u.parent));
      const u = pending.splice(idx, 1)[0]!;
      const parent = u.parent ? await tx.selectFrom('org_units').select(['id', 'path']).where('code', '=', u.parent).executeTakeFirstOrThrow() : null;
      const row = await tx.insertInto('org_units').values({ code: u.code, name: u.name, unit_type: u.type, parent_id: parent?.id ?? null, path: parent ? `${parent.path}.${u.code}` : u.code, latitude: u.lat, longitude: u.lon })
        .returning('id').executeTakeFirstOrThrow();
      await appendAudit(tx, actor, { action: 'ORG_UNIT_CREATED', resourceType: 'org_unit', resourceId: row.id, orgUnitId: row.id, details: { code: u.code, name: u.name, type: u.type, parent: u.parent, via: 'ops:bootstrap-org' } });
    }
    for (const { u, hash } of hashed) {
      const org = await tx.selectFrom('org_units').select('id').where('code', '=', u.unit).executeTakeFirstOrThrow();
      const role = await tx.selectFrom('roles').select('id').where('code', '=', u.role).executeTakeFirstOrThrow();
      const user = await tx.insertInto('users').values({
        username: u.username, full_name: u.name, badge_number: u.badge, rank: u.rank, email: u.email, home_org_unit_id: org.id,
        password_hash: hash, password_changed_at: new Date(), must_change_password: true,
      }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('password_history').values({ user_id: user.id, password_hash: hash }).execute();
      await tx.insertInto('user_roles').values({ user_id: user.id, role_id: role.id, org_unit_id: org.id }).execute();
      await appendAudit(tx, actor, { action: 'USER_CREATED', resourceType: 'user', resourceId: user.id, orgUnitId: org.id, details: { username: u.username, role: u.role, unit: u.unit, via: 'ops:bootstrap-org' } });
    }
    await appendAudit(tx, actor, {
      action: 'ORG_BOOTSTRAP_IMPORTED', resourceType: 'org',
      details: { unitsCreated: plan.unitsToCreate.length, unitsExisting: plan.unitsExisting.length, usersCreated: plan.usersToCreate.length, usersExisting: plan.usersExisting.length },
    });
  });
  return { unitsCreated: plan.unitsToCreate.length, usersCreated: plan.usersToCreate.length, credentials };
}
