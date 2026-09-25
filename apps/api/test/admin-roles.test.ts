import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@ksp/shared';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { auditChainIntact, auditFor, createAdmin, lastAudit, orgId, roleId, uniq, type AdminSession } from './admin-helpers.js';

afterAll(closeApp);

const R = '/api/v1/roles';
const U = '/api/v1/users';
let root: AdminSession;
let station: AdminSession; // SYSTEM_ADMINISTRATOR at ps_cubbonpark
let ksp: string;
let cubbon: string;
let indira: string;

beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
  station = await createAdmin({ org: 'ps_cubbonpark' });
  ksp = await orgId('ksp');
  cubbon = await orgId('ps_cubbonpark');
  indira = await orgId('ps_indiranagar');
});

describe('roles catalogue', () => {
  it('401 / 403 / happy path for reads', async () => {
    const anon = new Agent(await getApp());
    expect((await anon.get(R)).status).toBe(401);
    expect((await anon.get(`${R}/permissions`)).status).toBe(401);
    const io = await login('io.meera'); // no roles:read
    expect((await io.get(R)).status).toBe(403);
    expect((await io.post(R, { code: 'X_ROLE', name: 'Xrole', permissions: [] })).status).toBe(403);
    const list = await root.agent.get(R);
    expect(list.status).toBe(200);
    const sys = list.body.items.find((r: { code: string }) => r.code === 'SYSTEM_ADMINISTRATOR');
    expect(sys.isSystem).toBe(true);
    expect(sys.assignmentCount).toBeGreaterThan(0);
    const cat = await root.agent.get(`${R}/permissions`);
    expect(cat.body.groups.flatMap((g: { permissions: unknown[] }) => g.permissions)).toHaveLength(ALL_PERMISSIONS.length);
    expect(cat.body.groups.find((g: { category: string }) => g.category === 'evidence').permissions[0]).toHaveProperty('description');
    expect(cat.body.sodConflicts.length).toBeGreaterThan(0);
    expect((await root.agent.get(`${R}/${sys.id}`)).body.code).toBe('SYSTEM_ADMINISTRATOR');
    expect((await root.agent.get(`${R}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('creates, updates and deletes a custom role (validation, SoD, duplicates)', async () => {
    const code = uniq('CUSTOM_').toUpperCase();
    expect((await root.agent.post(R, { code, name: 'Device clerk', permissions: ['devices:read', 'no:such'] })).status).toBe(400);
    const sod = await root.agent.post(R, { code, name: 'Bad role', permissions: ['evidence:dispose_request', 'evidence:dispose_approve'] });
    expect(sod.status).toBe(422);
    expect(sod.body.error.code).toBe('SOD_VIOLATION');
    const c = await root.agent.post(R, { code, name: 'Device clerk', description: 'Keeps the camera register', permissions: ['devices:read', 'devices:manage', 'devices:read'] });
    expect(c.status).toBe(201);
    expect(c.body.permissions).toEqual(['devices:manage', 'devices:read']);
    expect(c.body.isSystem).toBe(false);
    expect((await root.agent.post(R, { code, name: 'Again', permissions: [] })).status).toBe(409);
    const up = await root.agent.patch(`${R}/${c.body.id}`, { name: 'Device registrar', permissions: ['devices:read', 'org:read'] });
    expect(up.status).toBe(200);
    expect(up.body.permissions).toEqual(['devices:read', 'org:read']);
    expect((await auditFor(c.body.id, 'ROLE_UPDATED'))[0]!.details).toMatchObject({ added: ['org:read'], removed: ['devices:manage'] });
    expect((await root.agent.patch(`${R}/${c.body.id}`, { permissions: ['audit:read', 'roles:manage'] })).status).toBe(422);
    expect((await root.agent.patch(`${R}/${c.body.id}`, { code: 'RENAMED' })).status).toBe(400);
    // in use => not deletable
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const g = await root.agent.post(`${U}/${t.id}/roles`, { roleId: c.body.id, orgUnitId: cubbon });
    expect(g.status).toBe(201);
    expect((await root.agent.delete(`${R}/${c.body.id}`)).status).toBe(409);
    expect((await root.agent.delete(`${U}/${t.id}/roles/${g.body.assignmentId}`)).status).toBe(200);
    expect((await root.agent.delete(`${R}/${c.body.id}`)).status).toBe(200);
    expect((await root.agent.get(`${R}/${c.body.id}`)).status).toBe(404);
    expect(await auditFor(c.body.id, 'ROLE_DELETED')).toHaveLength(1);
  });

  it('system roles cannot be deleted (API and database)', async () => {
    const id = await roleId('FORENSIC_ANALYST');
    expect((await root.agent.delete(`${R}/${id}`)).status).toBe(409);
    const app = await getApp();
    await expect(app.db.deleteFrom('roles').where('id', '=', id).execute()).rejects.toThrow(/system roles cannot be deleted/);
  });

  it('privilege escalation: station admin cannot create/extend roles with permissions they lack, nor touch system roles', async () => {
    const code = uniq('STN_').toUpperCase();
    const esc = await station.agent.post(R, { code, name: 'Sneaky viewer', permissions: ['devices:read', 'evidence:read'] });
    expect(esc.status).toBe(403);
    expect(esc.body.error.code).toBe('PRIVILEGE_ESCALATION');
    expect(esc.body.error.details.missing).toEqual(['evidence:read']);
    const ok = await station.agent.post(R, { code, name: 'Station device clerk', permissions: ['devices:read'] });
    expect(ok.status).toBe(201);
    const add = await station.agent.patch(`${R}/${ok.body.id}`, { permissions: ['devices:read', 'evidence:play'] });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('PRIVILEGE_ESCALATION');
    const sys = await station.agent.patch(`${R}/${await roleId('FIELD_OFFICER')}`, { description: 'changed by station admin' });
    expect(sys.status).toBe(403);
    expect(sys.body.error.code).toBe('OUT_OF_SCOPE');
    expect((await lastAudit('ADMIN_ACTION_DENIED'))?.details).toMatchObject({ rule: 'OUT_OF_SCOPE' });
  });

  it('nobody can change the permissions of a role they hold (no self-escalation / self-demotion)', async () => {
    const r = await root.agent.patch(`${R}/${await roleId('SYSTEM_ADMINISTRATOR')}`, { permissions: ['users:read', 'evidence:read'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_MODIFICATION');
  });

  it('a role change that gives a holder both sides of an SoD pair across roles is rejected', async () => {
    const code = uniq('SOD_').toUpperCase();
    const c = await root.agent.post(R, { code, name: 'Report reader', permissions: ['reports:generate'] });
    const t = await createUser({ role: 'EVIDENCE_CUSTODIAN', org: 'blr_city' }); // holds evidence:dispose_request
    expect((await root.agent.post(`${U}/${t.id}/roles`, { roleId: c.body.id, orgUnitId: cubbon })).status).toBe(201);
    const r = await root.agent.patch(`${R}/${c.body.id}`, { permissions: ['reports:generate', 'evidence:dispose_approve'] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SOD_VIOLATION');
    expect(r.body.error.details.affectedUsers).toContain(t.id);
  });
});

describe('role assignments', () => {
  it('401 / 403 / 404 / validation', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const fo = await roleId('FIELD_OFFICER');
    expect((await new Agent(await getApp()).post(`${U}/${t.id}/roles`, { roleId: fo, orgUnitId: cubbon })).status).toBe(401);
    const io = await login('io.meera');
    expect((await io.post(`${U}/${t.id}/roles`, { roleId: fo, orgUnitId: cubbon })).status).toBe(403);
    const other = await createUser({ role: 'FIELD_OFFICER', org: 'ps_indiranagar' });
    expect((await station.agent.post(`${U}/${other.id}/roles`, { roleId: await roleId('STATION_OPERATOR'), orgUnitId: cubbon })).status).toBe(404);
    expect((await root.agent.post(`${U}/${t.id}/roles`, { roleId: fo, orgUnitId: cubbon, expiresAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
    expect((await root.agent.post(`${U}/${t.id}/roles`, { roleId: '00000000-0000-4000-8000-000000000000', orgUnitId: cubbon })).status).toBe(400);
    expect((await root.agent.post(`${U}/${t.id}/roles`, { roleId: fo, orgUnitId: cubbon })).status).toBe(409); // already held
  });

  it('station-level admin cannot grant SYSTEM_ADMINISTRATOR at state level, nor roles above their own permissions', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const sa = await station.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('SYSTEM_ADMINISTRATOR'), orgUnitId: ksp });
    expect(sa.status).toBe(403);
    expect(sa.body.error.code).toBe('OUT_OF_SCOPE');
    const elsewhere = await station.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('FIELD_OFFICER'), orgUnitId: indira });
    expect(elsewhere.status).toBe(403);
    const io = await station.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('INVESTIGATING_OFFICER'), orgUnitId: cubbon });
    expect(io.status).toBe(403);
    expect(io.body.error.code).toBe('PRIVILEGE_ESCALATION');
    expect(io.body.error.details.missing).toContain('evidence:read');
    // A role whose permissions the station admin holds at the station is fine.
    const code = uniq('CLERK_').toUpperCase();
    const clerk = await root.agent.post(R, { code, name: 'Station clerk', permissions: ['devices:read', 'users:read'] });
    const ok = await station.agent.post(`${U}/${t.id}/roles`, { roleId: clerk.body.id, orgUnitId: cubbon, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(ok.status).toBe(201);
    expect(ok.body.user.roles.find((r: { roleCode: string }) => r.roleCode === code).expiresAt).toBeTruthy();
    const ev = await auditFor(t.id, 'ROLE_GRANTED');
    expect(ev.at(-1)!.details).toMatchObject({ role: code });
    // the state-level administrator may grant any role anywhere
    expect((await root.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('INVESTIGATING_OFFICER'), orgUnitId: cubbon })).status).toBe(201);
  });

  it('users cannot change their own roles', async () => {
    const grant = await root.agent.post(`${U}/${root.id}/roles`, { roleId: await roleId('AUDITOR'), orgUnitId: ksp });
    expect(grant.status).toBe(403);
    expect(grant.body.error.code).toBe('SELF_MODIFICATION');
    const detail = await root.agent.get(`${U}/${root.id}`);
    const own = detail.body.roles[0].id;
    const revoke = await root.agent.delete(`${U}/${root.id}/roles/${own}`);
    expect(revoke.status).toBe(403);
    expect(revoke.body.error.code).toBe('SELF_MODIFICATION');
  });

  it('SoD across roles: one user cannot hold disposal request AND approval', async () => {
    const t = await createUser({ role: 'EVIDENCE_CUSTODIAN', org: 'blr_city' });
    const r = await root.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('SUPERVISOR'), orgUnitId: await orgId('blr_central') });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SOD_VIOLATION');
    const create = await root.agent.post(U, {
      username: uniq('sod.'), fullName: 'SoD Combo', homeOrgUnitId: cubbon,
      roles: [{ roleId: await roleId('AUDITOR'), orgUnitId: cubbon }, { roleId: await roleId('SYSTEM_ADMINISTRATOR'), orgUnitId: cubbon }],
    });
    expect(create.status).toBe(422);
  });

  it('station admin cannot revoke a role granted at a unit outside their jurisdiction', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const g = await root.agent.post(`${U}/${t.id}/roles`, { roleId: await roleId('STATION_OPERATOR'), orgUnitId: indira });
    expect(g.status).toBe(201);
    const r = await station.agent.delete(`${U}/${t.id}/roles/${g.body.assignmentId}`);
    expect(r.status).toBe(403);
    expect((await root.agent.delete(`${U}/${t.id}/roles/${g.body.assignmentId}`, { reason: 'No longer needed there' })).status).toBe(200);
    expect((await root.agent.delete(`${U}/${t.id}/roles/${g.body.assignmentId}`)).status).toBe(404);
  });

  it('keeps the audit chain intact', async () => {
    expect(await auditChainIntact()).toBe(true);
  });
});
