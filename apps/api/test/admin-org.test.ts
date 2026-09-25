import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, closeApp, getApp, login } from './helpers.js';
import { auditChainIntact, auditFor, createAdmin, orgId, uniq, type AdminSession } from './admin-helpers.js';

afterAll(closeApp);

const O = '/api/v1/org';
let root: AdminSession;
let station: AdminSession;
let central: string;

beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
  station = await createAdmin({ org: 'ps_cubbonpark' });
  central = await orgId('blr_central');
});

describe('org units', () => {
  it('401 / 403 / list in tree order with manage flags', async () => {
    expect((await new Agent(await getApp()).get(O)).status).toBe(401);
    const fo = await login('fo.ravi'); // no org:read
    expect((await fo.get(O)).status).toBe(403);
    const io = await login('io.meera'); // org:read, no org:manage
    expect((await io.get(O)).status).toBe(200);
    expect((await io.post(O, { code: 'zz_unit', name: 'ZZ unit', unitType: 'UNIT', parentId: central })).status).toBe(403);
    const list = await station.agent.get(O);
    expect(list.status).toBe(200);
    const paths = list.body.items.map((u: { path: string }) => u.path);
    expect([...paths].sort()).toEqual(paths);
    const byCode = Object.fromEntries(list.body.items.map((u: { code: string; canManage: boolean }) => [u.code, u.canManage]));
    expect(byCode.ps_cubbonpark).toBe(true);
    expect(byCode.ps_indiranagar).toBe(false);
    expect(byCode.ksp).toBe(false);
    expect((await station.agent.get(`${O}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('creates a unit with a derived ltree path; validates; rejects duplicates and out-of-scope parents', async () => {
    const code = uniq('ps_t_').toLowerCase();
    expect((await root.agent.post(O, { code: 'Bad Code', name: 'Bad', unitType: 'STATION', parentId: central })).status).toBe(400);
    expect((await root.agent.post(O, { code, name: 'State two', unitType: 'STATE', parentId: central })).status).toBe(400);
    expect((await root.agent.post(O, { code, name: 'Bad lat', unitType: 'STATION', parentId: central, latitude: 123 })).status).toBe(400);
    const r = await root.agent.post(O, { code, name: 'Test Station', unitType: 'STATION', parentId: central, address: 'MG Road', phone: '080-2222-3333', latitude: 12.97, longitude: 77.6 });
    expect(r.status).toBe(201);
    expect(r.body.path).toBe(`ksp.blr_city.blr_central.${code}`);
    expect(r.body.depth).toBe(3);
    expect(await auditFor(r.body.id, 'ORG_UNIT_CREATED')).toHaveLength(1);
    expect((await root.agent.post(O, { code, name: 'Again', unitType: 'STATION', parentId: central })).status).toBe(409);
    const out = await station.agent.post(O, { code: uniq('u_').toLowerCase(), name: 'Out of scope', unitType: 'UNIT', parentId: await orgId('blr_east') });
    expect(out.status).toBe(403);
    // under a station only UNIT sub-units
    expect((await station.agent.post(O, { code: uniq('u_').toLowerCase(), name: 'Nested station', unitType: 'STATION', parentId: await orgId('ps_cubbonpark') })).status).toBe(400);
    const unit = await station.agent.post(O, { code: uniq('u_').toLowerCase(), name: 'Traffic cell', unitType: 'UNIT', parentId: await orgId('ps_cubbonpark') });
    expect(unit.status).toBe(201);
  });

  it('updates editable fields only; re-parenting is impossible (API and database)', async () => {
    const code = uniq('ps_e_').toLowerCase();
    const u = (await root.agent.post(O, { code, name: 'Editable Station', unitType: 'STATION', parentId: central })).body;
    const r = await root.agent.patch(`${O}/${u.id}`, { name: 'Edited Station', phone: '', latitude: 12.5 });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Edited Station');
    expect(r.body.phone).toBeNull();
    expect((await auditFor(u.id, 'ORG_UNIT_UPDATED'))[0]!.details).toMatchObject({ changes: { name: { from: 'Editable Station', to: 'Edited Station' } } });
    expect((await root.agent.patch(`${O}/${u.id}`, { parentId: await orgId('blr_east') })).status).toBe(400);
    expect((await root.agent.patch(`${O}/${u.id}`, { code: 'other' })).status).toBe(400);
    expect((await station.agent.patch(`${O}/${u.id}`, { name: 'Not mine' })).status).toBe(403);
    const app = await getApp();
    await expect(app.db.updateTable('org_units').set({ path: 'ksp.moved' }).where('id', '=', u.id).execute()).rejects.toThrow(/immutable/);
    await expect(app.db.deleteFrom('org_units').where('id', '=', u.id).execute()).rejects.toThrow(/cannot be deleted/);
  });

  it('deactivation rules: children first, never the root, never your own grant unit', async () => {
    const parentCode = uniq('sd_').toLowerCase();
    const parent = (await root.agent.post(O, { code: parentCode, name: 'Subdivision X', unitType: 'SUBDIVISION', parentId: central })).body;
    const child = (await root.agent.post(O, { code: uniq('ps_c_').toLowerCase(), name: 'Child station', unitType: 'STATION', parentId: parent.id })).body;
    expect((await root.agent.patch(`${O}/${parent.id}`, { active: false })).status).toBe(409);
    expect((await root.agent.patch(`${O}/${child.id}`, { active: false })).body.active).toBe(false);
    expect((await root.agent.patch(`${O}/${parent.id}`, { active: false })).body.active).toBe(false);
    expect((await root.agent.patch(`${O}/${child.id}`, { active: true })).status).toBe(409); // parent inactive
    expect((await root.agent.patch(`${O}/${await orgId('ksp')}`, { active: false })).status).toBe(409);
    const self = await station.agent.patch(`${O}/${await orgId('ps_cubbonpark')}`, { active: false });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_MODIFICATION');
    expect(await auditChainIntact()).toBe(true);
  });
});
