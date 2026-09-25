import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { auditChainIntact, auditFor, createAdmin, orgId, uniq, userIdOf, type AdminSession } from './admin-helpers.js';

afterAll(closeApp);

const D = '/api/v1/devices';
let root: AdminSession;
let station: AdminSession; // at ps_cubbonpark
let indiraAdmin: AdminSession; // at ps_indiranagar
let cubbon: string;
let indira: string;

beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
  station = await createAdmin({ org: 'ps_cubbonpark' });
  indiraAdmin = await createAdmin({ org: 'ps_indiranagar' });
  cubbon = await orgId('ps_cubbonpark');
  indira = await orgId('ps_indiranagar');
});

describe('devices', () => {
  it('401 / 403 on every endpoint', async () => {
    const anon = new Agent(await getApp());
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [m, url] of [['GET', D], ['GET', `${D}/${id}`], ['POST', D], ['PATCH', `${D}/${id}`], ['POST', `${D}/${id}/assign`], ['POST', `${D}/${id}/unassign`], ['POST', `${D}/${id}/retire`]] as const) {
      expect((await anon.request(m, url, m === 'GET' ? {} : { body: {} })).status, `${m} ${url}`).toBe(401);
    }
    const aud = await createUser({ role: 'FORENSIC_ANALYST', org: 'blr_city' }); // no devices:*
    const fa = await login(aud.username, aud.password);
    expect((await fa.get(D)).status).toBe(403);
    const io = await login('io.meera'); // devices:read only
    expect((await io.get(D)).status).toBe(200);
    expect((await io.post(D, { serialNumber: 'BWC-NOPE-1', orgUnitId: cubbon })).status).toBe(403);
  });

  it('registers, updates, assigns, unassigns and retires with audit; serial unique case-insensitively', async () => {
    const serial = uniq('bwc-').toUpperCase();
    expect((await station.agent.post(D, { serialNumber: '!!', orgUnitId: cubbon })).status).toBe(400);
    expect((await station.agent.post(D, { serialNumber: serial, orgUnitId: cubbon, deviceType: 'TOASTER' })).status).toBe(400);
    const r = await station.agent.post(D, { serialNumber: serial.toLowerCase(), deviceType: 'BODY_WORN_CAMERA', make: 'Axon', model: 'Body 4', firmwareVersion: '1.2.3', orgUnitId: cubbon });
    expect(r.status).toBe(201);
    expect(r.body.serialNumber).toBe(serial);
    expect(r.body.status).toBe('ACTIVE');
    expect((await station.agent.post(D, { serialNumber: serial, orgUnitId: cubbon })).status).toBe(409);
    const id = r.body.id as string;
    const up = await station.agent.patch(`${D}/${id}`, { firmwareVersion: '1.3.0', status: 'IN_REPAIR', notes: 'Lens cracked' });
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('IN_REPAIR');
    expect((await station.agent.patch(`${D}/${id}`, { status: 'RETIRED' })).status).toBe(400); // retire has its own endpoint
    const ravi = await userIdOf('fo.ravi');
    const as = await station.agent.post(`${D}/${id}/assign`, { officerId: ravi });
    expect(as.status).toBe(200);
    expect(as.body.assignedOfficer.id).toBe(ravi);
    expect((await station.agent.post(`${D}/${id}/assign`, { officerId: ravi })).status).toBe(409);
    // officer outside the admin's jurisdiction
    expect((await station.agent.post(`${D}/${id}/assign`, { officerId: await userIdOf('io.arjun') })).status).toBe(400);
    const list = await station.agent.get(`${D}?officerId=${ravi}`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await station.agent.post(`${D}/${id}/unassign`)).body.assignedOfficer).toBeNull();
    expect((await station.agent.post(`${D}/${id}/unassign`)).status).toBe(409);
    expect((await station.agent.post(`${D}/${id}/retire`, {})).status).toBe(400);
    const ret = await station.agent.post(`${D}/${id}/retire`, { reason: 'Beyond economical repair' });
    expect(ret.body.status).toBe('RETIRED');
    expect((await station.agent.patch(`${D}/${id}`, { notes: 'x' })).status).toBe(409);
    expect((await station.agent.post(`${D}/${id}/assign`, { officerId: ravi })).status).toBe(409);
    const detail = await station.agent.get(`${D}/${id}`);
    expect(detail.body.history.map((h: { action: string }) => h.action)).toEqual(['DEVICE_RETIRED', 'DEVICE_UNASSIGNED', 'DEVICE_ASSIGNED', 'DEVICE_UPDATED', 'DEVICE_REGISTERED']);
    expect((await auditFor(id, 'DEVICE_RETIRED'))[0]!.details).toMatchObject({ reason: 'Beyond economical repair' });
  });

  it('jurisdiction: other stations see 404; cannot register or transfer out of scope', async () => {
    const serial = uniq('DC-').toUpperCase();
    const d = (await station.agent.post(D, { serialNumber: serial, deviceType: 'DASH_CAMERA', orgUnitId: cubbon })).body;
    expect((await indiraAdmin.agent.get(`${D}/${d.id}`)).status).toBe(404);
    expect((await indiraAdmin.agent.patch(`${D}/${d.id}`, { notes: 'mine now' })).status).toBe(404);
    expect((await indiraAdmin.agent.post(`${D}/${d.id}/retire`, { reason: 'not my device at all' })).status).toBe(404);
    const list = await indiraAdmin.agent.get(`${D}?serial=${serial}`);
    expect(list.body.total).toBe(0);
    expect((await station.agent.post(D, { serialNumber: uniq('X-').toUpperCase(), orgUnitId: indira })).status).toBe(403);
    expect((await station.agent.patch(`${D}/${d.id}`, { orgUnitId: indira })).status).toBe(403);
    // a user with devices:read at the station sees it but cannot change it (403)
    const io = await login('io.meera');
    expect((await io.get(`${D}/${d.id}`)).status).toBe(200);
    expect((await io.patch(`${D}/${d.id}`, { notes: 'x' })).status).toBe(403);
    // the state admin can transfer it
    const t = await root.agent.patch(`${D}/${d.id}`, { orgUnitId: indira });
    expect(t.body.orgUnit.id).toBe(indira);
    expect((await indiraAdmin.agent.get(`${D}/${d.id}`)).status).toBe(200);
  });

  it('filters, sorts and paginates', async () => {
    const tag = uniq('FLT').toUpperCase();
    for (const [i, type] of (['BODY_WORN_CAMERA', 'DRONE', 'DRONE'] as const).entries()) {
      expect((await root.agent.post(D, { serialNumber: `${tag}-${i}`, deviceType: type, orgUnitId: cubbon })).status).toBe(201);
    }
    const all = await root.agent.get(`${D}?q=${tag}&sort=-serialNumber&pageSize=2`);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([`${tag}-2`, `${tag}-1`]);
    expect((await root.agent.get(`${D}?q=${tag}&type=DRONE`)).body.total).toBe(2);
    expect((await root.agent.get(`${D}?q=${tag}&assigned=true`)).body.total).toBe(0);
    expect((await root.agent.get(`${D}?q=${tag}&orgUnitId=${indira}`)).body.total).toBe(0);
    expect((await root.agent.get(`${D}?q=${tag}&status=ACTIVE`)).body.total).toBe(3);
    expect((await root.agent.get(`${D}?sort=org_unit_id`)).status).toBe(400);
    expect(await auditChainIntact()).toBe(true);
  });
});
