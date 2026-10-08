/**
 * Production first run on a FRESH database (created, migrated and dropped by this file):
 *   db:seed --production  -> root unit + one admin (one-time password, must change, MFA mandatory by role policy)
 *   ops:bootstrap-org     -> CSV import of units + users with full validation and dry-run
 *   ops:purge-demo-data   -> neutralises dev seed users / org units / fixture integrations; refuses on real data
 * and the production preflight's database rules on the result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import {
  createDb, databasePreflight, executeBootstrap, executeDemoPurge, loadConfig, migrate, parseCsv, planBootstrap, planDemoPurge, systemActor, verifySecret,
  type AppConfig, type Database,
} from '@ksp/core';
import { DEV_PASSWORD, seedDev, seedProduction } from '@ksp/core/dev-seed';

const name = `ksp_opsfr_${randomBytes(3).toString('hex')}`;
let db: Database;
let prodCfg: AppConfig;
let adminPassword: string;
const withDb = (url: string) => url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);

beforeAll(async () => {
  const cfg = loadConfig();
  const admin = new pg.Client({ connectionString: cfg.DATABASE_MIGRATION_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await migrate(withDb(cfg.DATABASE_MIGRATION_URL!), () => undefined);
  db = createDb(withDb(cfg.DATABASE_URL), 3).db;
  prodCfg = { ...cfg, NODE_ENV: 'production', KSP_ENVIRONMENT: 'production', AI_LEGAL_GATES: 'enforce', DATABASE_TLS_WAIVED: true };
}, 180_000);

afterAll(async () => {
  await db?.destroy();
  const admin = new pg.Client({ connectionString: loadConfig().DATABASE_MIGRATION_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

const rules = async () => (await databasePreflight(db, prodCfg, 'api')).map((f) => `${f.severity}:${f.rule}`);

describe('db:seed --production', () => {
  it('creates only the root unit and one administrator with a one-time password; MFA mandatory; idempotent', async () => {
    const r = await seedProduction(db);
    expect(r.password).toMatch(/^.{16,}$/);
    adminPassword = r.password!;
    expect(r.warnings).toEqual([]);
    const units = await db.selectFrom('org_units').select(['code', 'unit_type']).execute();
    expect(units).toEqual([{ code: 'ksp', unit_type: 'STATE' }]);
    const users = await db.selectFrom('users').select(['username', 'must_change_password', 'password_hash', 'status', 'mfa_enabled']).execute();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: 'admin', must_change_password: true, status: 'ACTIVE', mfa_enabled: false });
    expect(await verifySecret(users[0]!.password_hash!, adminPassword)).toBe(true);
    expect(await verifySecret(users[0]!.password_hash!, DEV_PASSWORD)).toBe(false);
    const role = await db.selectFrom('user_roles as ur').innerJoin('roles as r', 'r.id', 'ur.role_id').select('r.code').execute();
    expect(role.map((x) => x.code)).toEqual(['SYSTEM_ADMINISTRATOR']);
    const session = await db.selectFrom('system_settings').select('value').where('key', '=', 'sessionPolicy').executeTakeFirstOrThrow();
    expect((session.value as { requireMfaForRoles: string[] }).requireMfaForRoles).toContain('SYSTEM_ADMINISTRATOR');
    expect(await db.selectFrom('integration_systems').select('id').execute()).toEqual([]);
    expect((await seedProduction(db)).password).toBeNull(); // second run changes nothing
    // Preflight on the fresh production database: no dev users, no dev password, no demo org units.
    const f = await rules();
    expect(f.filter((x) => x.startsWith('error:'))).toEqual([]);
    expect(f).not.toContain('warning:DEV_SEED_ORG');
  });
});

describe('ops:bootstrap-org', () => {
  const units = [
    'code,name,type,parent,lat,lon',
    'ps_malleshwaram,"Malleshwaram Police Station, Bengaluru",STATION,blr_north,13.0035,77.5707',
    'blr_north,North Division,DISTRICT,blr_cp,,',
    'blr_cp,Bengaluru City Police,COMMISSIONERATE,ksp,,',
  ].join('\r\n');
  const users = [
    'username,name,badge,rank,email,unit,role',
    'io.sharma,Anil Sharma,KSP-4411,Sub-Inspector,anil.sharma@ksp.gov.in,ps_malleshwaram,INVESTIGATING_OFFICER',
    'sup.rao,Priya Rao,KSP-5120,Inspector,priya.rao@ksp.gov.in,blr_north,SUPERVISOR',
  ].join('\n');

  it('parses RFC 4180 CSV', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });

  it('reports every validation error and writes nothing', async () => {
    const bad = await planBootstrap(db, {
      unitsCsv: ['code,name,type,parent,lat,lon,extra', 'x,,PLANET,nowhere,91,,1', 'a1,A,STATION,b1,12.5,', 'b1,B,DISTRICT,a1,,', 'a1,dup,UNIT,ksp,,'].join('\n'),
      usersCsv: ['username,name,badge,rank,email,unit,role', 'Bad User!,X,,,not-an-email,ghost,WIZARD', 'u.one,One,B1,,,ksp,AUDITOR', 'u.one,Two,B1,,,ksp,AUDITOR'].join('\n'),
    });
    const e = bad.errors.join('\n');
    for (const m of [/unknown column\(s\) extra/, /code 'x' must be/, /name is required/, /type 'PLANET'/, /lat '91'/, /both lat and lon/, /parent 'nowhere'/, /parent cycle/, /duplicate code 'a1'/,
      /username 'Bad User!'/, /invalid e-mail/, /unit 'ghost' not found/, /unknown role 'WIZARD'/, /duplicate username 'u.one'/, /badge 'B1' is already used/]) expect(e).toMatch(m);
    await expect(executeBootstrap(db, bad, systemActor('test'))).rejects.toThrow(/validation error/);
    expect(await db.selectFrom('org_units').select('code').execute()).toHaveLength(1);
  });

  it('dry-run plan, import (parents first), one-time passwords, audit; re-run is a no-op', async () => {
    const plan = await planBootstrap(db, { unitsCsv: units, usersCsv: users });
    expect(plan.errors).toEqual([]);
    expect(plan.unitsToCreate.map((u) => u.code)).toEqual(['ps_malleshwaram', 'blr_north', 'blr_cp']);
    const r = await executeBootstrap(db, plan, systemActor('ops-test'));
    expect(r).toMatchObject({ unitsCreated: 3, usersCreated: 2 });
    const st = await db.selectFrom('org_units').select(['path', 'name', 'latitude']).where('code', '=', 'ps_malleshwaram').executeTakeFirstOrThrow();
    expect(st).toMatchObject({ path: 'ksp.blr_cp.blr_north.ps_malleshwaram', name: 'Malleshwaram Police Station, Bengaluru', latitude: 13.0035 });
    const u = await db.selectFrom('users').select(['password_hash', 'must_change_password', 'email']).where('username', '=', 'io.sharma').executeTakeFirstOrThrow();
    expect(u.must_change_password).toBe(true);
    expect(await verifySecret(u.password_hash!, r.credentials.find((c) => c.username === 'io.sharma')!.oneTimePassword)).toBe(true);
    const audit = await db.selectFrom('audit_events').select(['action', 'details']).where('action', 'in', ['ORG_BOOTSTRAP_IMPORTED', 'USER_CREATED', 'ORG_UNIT_CREATED']).execute();
    expect(audit.filter((a) => a.action === 'ORG_UNIT_CREATED')).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain(r.credentials[0]!.oneTimePassword); // passwords never audited
    const again = await planBootstrap(db, { unitsCsv: units, usersCsv: users });
    expect(again).toMatchObject({ errors: [], unitsToCreate: [], usersToCreate: [] });
    expect(again.usersExisting.sort()).toEqual(['io.sharma', 'sup.rao']);
  });
});

describe('ops:purge-demo-data', () => {
  it('refuses on the production tier without --i-understand; neutralises dev data; preflight then passes', async () => {
    await seedDev(db); // UAT fixtures on top of the production seed (admin keeps its one-time password)
    await db.insertInto('integration_systems').values({ code: 'cctns_fixture', name: 'CCTNS (fixture)', system_type: 'CCTNS', adapter: 'fixture', enabled: true }).execute();
    expect(await rules()).toEqual(expect.arrayContaining(['error:DEV_SEED_USERS', 'error:DEV_SEED_PASSWORD', 'error:FIXTURE_INTEGRATION', 'warning:DEV_SEED_ORG']));
    const prodPlan = await planDemoPurge(db, prodCfg);
    expect(prodPlan.refused).toMatch(/--i-understand/);
    await expect(executeDemoPurge(db, prodPlan, systemActor('t'))).rejects.toThrow(/refused/);
    const plan = await planDemoPurge(db, { ...prodCfg, KSP_ENVIRONMENT: 'staging' });
    expect(plan.refused).toBeNull();
    expect(plan.usersToDisable).toEqual(expect.arrayContaining(['io.meera', 'sup.kavya']));
    expect(plan.usersToDisable).not.toContain('admin');
    expect(plan.adminPasswordReset).toBe(false);
    expect(plan.orgUnitsToDeactivate).toContain('ps_cubbonpark');
    expect(plan.fixtureSystemsToDisable).toEqual(['cctns_fixture']);
    const r = await executeDemoPurge(db, plan, systemActor('ops-test'));
    expect(r.executed).toBe(true);
    const meera = await db.selectFrom('users').select(['status', 'password_hash']).where('username', '=', 'io.meera').executeTakeFirstOrThrow();
    expect(meera.status).toBe('DISABLED');
    expect(await verifySecret(meera.password_hash!, DEV_PASSWORD)).toBe(false);
    expect(await db.selectFrom('user_roles as ur').innerJoin('users as u', 'u.id', 'ur.user_id').select('u.username').where('u.username', '=', 'io.meera').execute()).toEqual([]);
    const admin = await db.selectFrom('users').select('password_hash').where('username', '=', 'admin').executeTakeFirstOrThrow();
    expect(await verifySecret(admin.password_hash!, adminPassword)).toBe(true); // real admin untouched
    expect((await db.selectFrom('audit_events').select('details').where('action', '=', 'DEMO_DATA_PURGED').executeTakeFirstOrThrow()).details).toMatchObject({ fixtureSystemsDisabled: ['cctns_fixture'] });
    const f = await rules();
    expect(f.filter((x) => x.startsWith('error:'))).toEqual([]);
    expect(f).not.toContain('warning:DEV_SEED_ORG');
  });

  it("resets the 'admin' dev password with a new one-time password", async () => {
    const { hashSecret } = await import('@ksp/core');
    await db.updateTable('users').set({ password_hash: await hashSecret(DEV_PASSWORD) }).where('username', '=', 'admin').execute();
    const plan = await planDemoPurge(db, { ...prodCfg, KSP_ENVIRONMENT: 'staging' });
    expect(plan.adminPasswordReset).toBe(true);
    const r = await executeDemoPurge(db, plan, systemActor('ops-test'));
    const admin = await db.selectFrom('users').select(['password_hash', 'must_change_password']).where('username', '=', 'admin').executeTakeFirstOrThrow();
    expect(await verifySecret(admin.password_hash!, r.adminOneTimePassword!)).toBe(true);
    expect(admin.must_change_password).toBe(true);
  });

  it('refuses whenever evidence exists in a real (non-demo) unit, even with --i-understand', async () => {
    const unit = await db.selectFrom('org_units').select(['id', 'path']).where('code', '=', 'ps_malleshwaram').executeTakeFirstOrThrow();
    const uploader = await db.selectFrom('users').select('id').where('username', '=', 'io.sharma').executeTakeFirstOrThrow();
    await db.insertInto('evidence').values({ org_unit_id: unit.id, org_path: unit.path, uploaded_by: uploader.id, original_filename: 'bwc_0001.mp4', size_bytes: 1024 } as never).execute();
    const plan = await planDemoPurge(db, prodCfg, { iUnderstand: true });
    expect(plan.refused).toMatch(/non-demo org units \(ps_malleshwaram: 1\)/);
    expect(plan.realEvidence).toEqual({ count: 1, units: ['ps_malleshwaram'] });
    await expect(executeDemoPurge(db, plan, systemActor('t'))).rejects.toThrow(/refused/);
  });
});
