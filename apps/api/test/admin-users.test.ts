import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { auditChainIntact, auditFor, createAdmin, lastAudit, orgId, roleId, uniq, type AdminSession } from './admin-helpers.js';
import { clearLoginFailures } from './admin-helpers.js';

afterAll(closeApp);

const U = '/api/v1/users';
let root: AdminSession;
let station: AdminSession; // SYSTEM_ADMINISTRATOR at ps_cubbonpark only
let cubbon: string;
let indira: string;
let foRole: string;

beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
  station = await createAdmin({ org: 'ps_cubbonpark' });
  cubbon = await orgId('ps_cubbonpark');
  indira = await orgId('ps_indiranagar');
  foRole = await roleId('FIELD_OFFICER');
});

describe('users: authentication & authorization', () => {
  it('401 without a session on every endpoint', async () => {
    const anon = new Agent(await getApp());
    const id = root.id;
    for (const [m, url] of [['GET', U], ['GET', `${U}/${id}`], ['POST', U], ['PATCH', `${U}/${id}`], ['POST', `${U}/${id}/status`], ['POST', `${U}/${id}/unlock`],
      ['POST', `${U}/${id}/reset-password`], ['POST', `${U}/${id}/reset-mfa`], ['GET', `${U}/${id}/sessions`], ['POST', `${U}/${id}/sessions/revoke-all`],
      ['POST', `${U}/${id}/roles`]] as const) {
      const r = await anon.request(m, url, m === 'GET' ? {} : { body: {} });
      expect(r.status, `${m} ${url}`).toBe(401);
    }
  });

  it('403 without users:read / users:manage', async () => {
    const fo = await login('fo.ravi');
    expect((await fo.get(U)).status).toBe(403);
    const io = await login('io.meera'); // users:read only
    expect((await io.get(U)).status).toBe(200);
    expect((await io.post(U, { username: 'x.y.z', fullName: 'Valid Name', homeOrgUnitId: cubbon })).status).toBe(403);
    const target = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const r = await io.post(`${U}/${target.id}/status`, { status: 'DISABLED', reason: 'testing permissions' });
    expect(r.status).toBe(403);
  });

  it('MFA-mandatory: an administrator without MFA is blocked from admin endpoints', async () => {
    const noMfa = await createAdmin({ org: 'ksp', mfa: false });
    const r = await noMfa.agent.get(U);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('station administrator only sees and manages users of their station (404 elsewhere)', async () => {
    const list = await station.agent.get(`${U}?pageSize=200`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const u of list.body.items) expect(u.homeOrgUnit.code).toBe('ps_cubbonpark');
    const other = await createUser({ role: 'FIELD_OFFICER', org: 'ps_indiranagar' });
    expect((await station.agent.get(`${U}/${other.id}`)).status).toBe(404);
    expect((await station.agent.patch(`${U}/${other.id}`, { fullName: 'Hacked' })).status).toBe(404);
    expect((await station.agent.post(`${U}/${other.id}/status`, { status: 'DISABLED', reason: 'out of scope attempt' })).status).toBe(404);
    expect((await station.agent.post(`${U}/${other.id}/reset-password`, { reason: 'out of scope attempt' })).status).toBe(404);
    expect((await station.agent.get(`${U}/${other.id}/sessions`)).status).toBe(404);
    const create = await station.agent.post(U, { username: uniq('st.'), fullName: 'Elsewhere User', homeOrgUnitId: indira });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('OUT_OF_SCOPE');
    expect((await lastAudit('ADMIN_ACTION_DENIED'))?.details).toMatchObject({ rule: 'OUT_OF_SCOPE' });
    // moving a user out of scope is refused too
    const mine = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const mv = await station.agent.patch(`${U}/${mine.id}`, { homeOrgUnitId: indira });
    expect(mv.status).toBe(403);
  });

  it('404 for unknown ids and 400 for malformed ids', async () => {
    expect((await root.agent.get(`${U}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await root.agent.get(`${U}/not-a-uuid`)).status).toBe(400);
  });
});

describe('users: lifecycle', () => {
  it('creates a user with a one-time temporary password and forced change; never leaks secrets', async () => {
    const username = uniq('new.officer');
    const r = await root.agent.post(U, {
      username, fullName: 'New Officer', email: `${username}@ksp.example.invalid`, badgeNumber: uniq('B-'), rank: 'Constable', designation: 'PC', phone: '+91 80 1234 5678',
      homeOrgUnitId: cubbon, roles: [{ roleId: foRole, orgUnitId: cubbon }],
    });
    expect(r.status).toBe(201);
    const pw = r.body.temporaryPassword as string;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
    expect(r.body.user.mustChangePassword).toBe(true);
    expect(r.body.user.roles.map((x: { roleCode: string }) => x.roleCode)).toEqual(['FIELD_OFFICER']);
    const detail = await root.agent.get(`${U}/${r.body.user.id}`);
    expect(detail.status).toBe(200);
    expect(detail.raw).not.toMatch(/argon2|password_hash|passwordHash|mfa_secret|mfaSecret|recovery/i);
    expect(detail.raw).not.toContain(pw);
    // audit written, never containing the password
    const ev = await auditFor(r.body.user.id, 'USER_CREATED');
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]!.details)).not.toContain(pw);
    // the temporary password works exactly for a forced password change
    const u = await login(username, pw);
    const blocked = await u.get('/api/v1/auth/sessions');
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('validates input and rejects duplicates', async () => {
    expect((await root.agent.post(U, { username: 'Bad Name!', fullName: 'X Y', homeOrgUnitId: cubbon })).status).toBe(400);
    expect((await root.agent.post(U, { username: uniq('ok.'), fullName: 'X Y', email: 'not-an-email', homeOrgUnitId: cubbon })).status).toBe(400);
    expect((await root.agent.post(U, { username: uniq('ok.'), fullName: 'X Y', homeOrgUnitId: cubbon, passwordHash: 'x' })).status).toBe(400);
    const dup = await root.agent.post(U, { username: 'io.meera', fullName: 'Duplicate', homeOrgUnitId: cubbon });
    expect(dup.status).toBe(409);
  });

  it('updates profile fields with an audit trail', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const r = await station.agent.patch(`${U}/${t.id}`, { fullName: 'Renamed Officer', rank: 'Head Constable', email: '' });
    expect(r.status).toBe(200);
    expect(r.body.fullName).toBe('Renamed Officer');
    expect(r.body.email).toBeNull();
    const ev = await auditFor(t.id, 'USER_UPDATED');
    expect(ev.at(-1)!.details).toMatchObject({ changes: { full_name: { to: 'Renamed Officer' } } });
    expect((await station.agent.patch(`${U}/${t.id}`, {})).status).toBe(400);
  });

  it('disabling revokes sessions immediately; self-disable is refused; reason required', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const user = await login(t.username, t.password);
    expect((await user.get('/api/v1/auth/me')).status).toBe(200);
    expect((await station.agent.post(`${U}/${t.id}/status`, { status: 'DISABLED' })).status).toBe(400);
    expect((await station.agent.post(`${U}/${t.id}/status`, { status: 'DISABLED', reason: 'no' })).status).toBe(400);
    const r = await station.agent.post(`${U}/${t.id}/status`, { status: 'DISABLED', reason: 'Transferred out of the department' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('DISABLED');
    expect(r.body.statusReason).toBe('Transferred out of the department');
    expect(r.body.activeSessions).toBe(0);
    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    // cannot log in any more
    const again = await new Agent(await getApp()).post('/api/v1/auth/login', { username: t.username, password: t.password });
    expect(again.status).toBe(403);
    // same status twice => 409; re-activate works
    expect((await station.agent.post(`${U}/${t.id}/status`, { status: 'DISABLED', reason: 'again and again' })).status).toBe(409);
    expect((await station.agent.post(`${U}/${t.id}/status`, { status: 'ACTIVE', reason: 'Rejoined the station' })).body.status).toBe('ACTIVE');
    expect((await login(t.username, t.password)).cookies.size).toBeGreaterThan(0);
    // self
    const self = await station.agent.post(`${U}/${station.id}/status`, { status: 'DISABLED', reason: 'disable myself please' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_MODIFICATION');
    const ev = await auditFor(t.id, 'USER_STATUS_CHANGED');
    expect(ev.map((e) => (e.details as { to: string }).to)).toEqual(['DISABLED', 'ACTIVE']);
  });

  it('unlocks a user locked out by failed logins', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const app = await getApp();
    for (let i = 0; i < 5; i++) await new Agent(app).post('/api/v1/auth/login', { username: t.username, password: 'wrong-password' });
    expect((await new Agent(app).post('/api/v1/auth/login', { username: t.username, password: t.password })).status).toBe(423);
    const d = await station.agent.get(`${U}/${t.id}`);
    expect(d.body.locked).toBe(true);
    const r = await station.agent.post(`${U}/${t.id}/unlock`, { reason: 'Verified identity by phone' });
    expect(r.status).toBe(200);
    expect(r.body.locked).toBe(false);
    expect(r.body.failedLoginCount).toBe(0);
    expect((await new Agent(app).post('/api/v1/auth/login', { username: t.username, password: t.password })).status).toBe(200);
    expect(await auditFor(t.id, 'USER_UNLOCKED')).toHaveLength(1);
    await clearLoginFailures();
  });

  it('administrative password reset: one-time password, forced change, sessions revoked', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const user = await login(t.username, t.password);
    expect((await station.agent.post(`${U}/${t.id}/reset-password`, {})).status).toBe(400);
    const r = await station.agent.post(`${U}/${t.id}/reset-password`, { reason: 'Officer forgot password' });
    expect(r.status).toBe(200);
    expect(r.body.sessionsRevoked).toBe(1);
    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    const app = await getApp();
    expect((await new Agent(app).post('/api/v1/auth/login', { username: t.username, password: t.password })).status).toBe(401);
    const fresh = await login(t.username, r.body.temporaryPassword);
    expect((await fresh.get('/api/v1/auth/me')).body.user.mustChangePassword).toBe(true);
    expect((await station.agent.post(`${U}/${station.id}/reset-password`, { reason: 'my own password' })).status).toBe(403);
    const ev = await auditFor(t.id, 'USER_PASSWORD_RESET');
    expect(JSON.stringify(ev)).not.toContain(r.body.temporaryPassword);
  });

  it('MFA reset clears enrolment and revokes sessions', async () => {
    const t = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const user = await login(t.username, t.password);
    const { enrolMfa } = await import('./admin-helpers.js');
    await enrolMfa(user);
    expect((await station.agent.get(`${U}/${t.id}`)).body.mfaEnabled).toBe(true);
    // station admin lacks nothing for users:manage at cubbon park
    const r = await station.agent.post(`${U}/${t.id}/reset-mfa`, { reason: 'Lost phone with authenticator' });
    expect(r.status).toBe(200);
    expect(r.body.mfaEnabled).toBe(false);
    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    const app = await getApp();
    const again = await new Agent(app).post('/api/v1/auth/login', { username: t.username, password: t.password });
    expect(again.status).toBe(200);
    expect(again.body.mfaRequired).toBeUndefined();
  });

  it('lists and revokes sessions', async () => {
    const t = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(t.username, t.password);
    const b = await login(t.username, t.password);
    const list = await station.agent.get(`${U}/${t.id}/sessions`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['absoluteExpiresAt', 'createdAt', 'current', 'id', 'idleExpiresAt', 'ip', 'lastSeenAt', 'mfaVerified', 'userAgent']);
    const one = list.body.items[0].id;
    expect((await station.agent.delete(`${U}/${t.id}/sessions/${one}`)).status).toBe(200);
    expect((await station.agent.delete(`${U}/${t.id}/sessions/${one}`)).status).toBe(404);
    const alive = [(await a.get('/api/v1/auth/me')).status, (await b.get('/api/v1/auth/me')).status].sort();
    expect(alive).toEqual([200, 401]);
    const all = await station.agent.post(`${U}/${t.id}/sessions/revoke-all`, { reason: 'Suspected compromise' });
    expect(all.body.revoked).toBe(1);
    expect((await a.get('/api/v1/auth/me')).status).toBe(401);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('filters and paginates the list', async () => {
    const tag = uniq('filt');
    for (let i = 0; i < 3; i++) {
      const r = await root.agent.post(U, { username: `${tag}.${i}`, fullName: `Filter ${tag} ${i}`, homeOrgUnitId: indira, roles: [{ roleId: foRole, orgUnitId: indira }] });
      expect(r.status).toBe(201);
    }
    const p1 = await root.agent.get(`${U}?q=${tag}&pageSize=2&sort=username`);
    expect(p1.body.total).toBe(3);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0].username).toBe(`${tag}.0`);
    const p2 = await root.agent.get(`${U}?q=${tag}&pageSize=2&page=2&sort=username`);
    expect(p2.body.items.map((x: { username: string }) => x.username)).toEqual([`${tag}.2`]);
    expect((await root.agent.get(`${U}?q=${tag}&roleCode=SUPERVISOR`)).body.total).toBe(0);
    expect((await root.agent.get(`${U}?q=${tag}&roleCode=FIELD_OFFICER`)).body.total).toBe(3);
    expect((await root.agent.get(`${U}?q=${tag}&orgUnitId=${cubbon}`)).body.total).toBe(0);
    expect((await root.agent.get(`${U}?q=${tag}&orgUnitId=${await orgId('blr_city')}`)).body.total).toBe(3);
    expect((await root.agent.get(`${U}?q=${tag}&status=DISABLED`)).body.total).toBe(0);
    expect((await root.agent.get(`${U}?sort=password_hash`)).status).toBe(400);
    expect((await root.agent.get(`${U}?pageSize=500`)).status).toBe(400);
  });

  it('keeps the audit chain intact', async () => {
    expect(await auditChainIntact()).toBe(true);
  });
});
