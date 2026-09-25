/**
 * Session & authorization protections that were previously untested: idle timeout, absolute timeout,
 * concurrent-session limit, immediate effect of disabling a user and of revoking a role, MFA-mandatory
 * enforcement for administrators, ACCESS_DENIED auditing, and the lock-out (last administrator) guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, createUser, getApp, login } from './helpers.js';
import { auditChainIntact, createAdmin, lastAudit, loginWithMfa, orgId, roleId, type AdminSession } from './admin-helpers.js';
import { sql } from 'kysely';
import { invalidatePrincipals } from '../src/lib/load-principal.js';

afterAll(closeApp);

let root: AdminSession;
beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
});

async function sessionIdOf(agent: Awaited<ReturnType<typeof login>>): Promise<string> {
  return (await agent.get('/api/v1/auth/me')).body.sessionId as string;
}

describe('session protections', () => {
  it('idle timeout: a session past idle_expires_at is rejected and cannot be refreshed', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    const sid = await sessionIdOf(a);
    const app = await getApp();
    await app.db.updateTable('sessions').set({ idle_expires_at: new Date(Date.now() - 1000), last_seen_at: new Date(Date.now() - 31 * 60_000) }).where('id', '=', sid).execute();
    expect((await a.get('/api/v1/auth/me')).status).toBe(401);
    expect((await a.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('absolute timeout: a session past absolute_expires_at is rejected even if recently active', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    const sid = await sessionIdOf(a);
    const app = await getApp();
    await app.db.updateTable('sessions').set({ absolute_expires_at: new Date(Date.now() - 1000) }).where('id', '=', sid).execute();
    expect((await a.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('sliding idle window: activity extends idle expiry (capped at the absolute expiry)', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    const sid = await sessionIdOf(a);
    const app = await getApp();
    const soon = new Date(Date.now() + 60_000);
    await app.db.updateTable('sessions').set({ idle_expires_at: soon, last_seen_at: new Date(Date.now() - 5 * 60_000) }).where('id', '=', sid).execute();
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
    const s = await app.db.selectFrom('sessions').select(['idle_expires_at', 'absolute_expires_at']).where('id', '=', sid).executeTakeFirstOrThrow();
    expect(s.idle_expires_at.getTime()).toBeGreaterThan(soon.getTime() + 20 * 60_000);
    expect(s.idle_expires_at.getTime()).toBeLessThanOrEqual(s.absolute_expires_at.getTime());
  });

  it('concurrent-session limit: the oldest session is revoked when the limit (3) is exceeded', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const agents = [];
    for (let i = 0; i < 4; i++) agents.push(await login(u.username, u.password));
    const statuses = [];
    for (const a of agents) statuses.push((await a.get('/api/v1/auth/me')).status);
    expect(statuses).toEqual([401, 200, 200, 200]);
    const app = await getApp();
    const revoked = await app.db.selectFrom('sessions').select('revoke_reason').where('user_id', '=', u.id).where('revoked_at', 'is not', null).execute();
    expect(revoked.map((r) => r.revoke_reason)).toEqual(['CONCURRENT_LIMIT']);
  });

  it("disabling a user stops their existing session on the very next request (even with a warm principal cache)", async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    expect((await a.get('/api/v1/evidence')).status).toBe(200); // principal now cached
    const r = await root.agent.post(`/api/v1/users/${u.id}/status`, { status: 'DISABLED', reason: 'Suspended pending inquiry' });
    expect(r.status).toBe(200);
    expect((await a.get('/api/v1/evidence')).status).toBe(401);
    expect((await a.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('a user disabled directly in the database loses access once principals are invalidated', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    expect((await a.get('/api/v1/evidence')).status).toBe(200);
    const app = await getApp();
    await app.db.updateTable('users').set({ status: 'DISABLED' }).where('id', '=', u.id).execute();
    invalidatePrincipals(u.id);
    expect((await a.get('/api/v1/evidence')).status).toBe(401);
  });

  it('role revocation takes effect immediately (invalidatePrincipals)', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const g = await root.agent.post(`/api/v1/users/${u.id}/roles`, { roleId: await roleId('INVESTIGATING_OFFICER'), orgUnitId: await orgId('ps_cubbonpark') });
    expect(g.status).toBe(201);
    const a = await login(u.username, u.password);
    expect((await a.get('/api/v1/users')).status).toBe(200); // users:read via the IO role
    const del = await root.agent.delete(`/api/v1/users/${u.id}/roles/${g.body.assignmentId}`);
    expect(del.status).toBe(200);
    const after = await a.get('/api/v1/users');
    expect(after.status).toBe(403);
    expect((await a.get('/api/v1/auth/me')).body.permissions).not.toContain('users:read');
  });

  it('role expiry is honoured without any administrative action', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const g = await root.agent.post(`/api/v1/users/${u.id}/roles`, { roleId: await roleId('STATION_OPERATOR'), orgUnitId: await orgId('ps_cubbonpark'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const a = await login(u.username, u.password);
    expect((await a.get('/api/v1/users')).status).toBe(200);
    const app = await getApp();
    await app.db.updateTable('user_roles').set({ granted_at: new Date(Date.now() - 7_200_000), expires_at: new Date(Date.now() - 1000) }).where('id', '=', g.body.assignmentId).execute();
    invalidatePrincipals(u.id); // cache TTL is 10 s; the DB check itself honours expiry
    expect((await a.get('/api/v1/users')).status).toBe(403);
  });
});

describe('administrator protections', () => {
  it('MFA is mandatory for administrators: without enrolment every admin endpoint is blocked; with it they work', async () => {
    const adm = await createAdmin({ org: 'ksp', mfa: false });
    for (const url of ['/api/v1/users', '/api/v1/roles', '/api/v1/org', '/api/v1/devices', '/api/v1/settings']) {
      const r = await adm.agent.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    }
    // the fully enrolled admin logs in with password + TOTP and is allowed
    const again = await loginWithMfa(root.username, root.password, root.secret);
    expect((await again.get('/api/v1/users')).status).toBe(200);
    // and MFA cannot be self-disabled while mandatory
    const dis = await again.post('/api/v1/auth/mfa/disable', { password: root.password, code: '000000' });
    expect(dis.status).toBe(403);
  });

  it('permission denials are audited as ACCESS_DENIED', async () => {
    const fo = await login('fo.ravi');
    expect((await fo.get('/api/v1/settings')).status).toBe(403);
    const ev = await lastAudit('ACCESS_DENIED');
    expect(ev?.details).toMatchObject({ missing: ['settings:manage'] });
  });

  it('the last state-level administrator cannot be disabled (lock-out protection)', async () => {
    const app = await getApp();
    // A user administrator WITHOUT roles:manage (custom role at state level) could otherwise disable the last root admin.
    const code = `USER_ADMIN_${Date.now().toString(36).toUpperCase()}`;
    const role = await root.agent.post('/api/v1/roles', { code, name: 'User administrator', permissions: ['users:read', 'users:manage'] });
    expect(role.status).toBe(201);
    const ua = await createUser({ role: 'FIELD_OFFICER', org: 'ksp' });
    expect((await root.agent.post(`/api/v1/users/${ua.id}/roles`, { roleId: role.body.id, orgUnitId: await orgId('ksp') })).status).toBe(201);
    const userAdmin = await login(ua.username, ua.password);
    // Temporarily make `root` the only ACTIVE state-level roles:manage holder.
    const others = await app.db.selectFrom('users as u').innerJoin('user_roles as ur', 'ur.user_id', 'u.id').innerJoin('roles as r', 'r.id', 'ur.role_id').innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
      .select('u.id').distinct().where('o.parent_id', 'is', null).where('u.status', '=', 'ACTIVE').where('u.id', '<>', root.id)
      .where(sql<boolean>`'roles:manage' = ANY (r.permissions)`).execute();
    const ids = others.map((o) => o.id);
    if (ids.length) await app.db.updateTable('users').set({ status: 'PENDING' }).where('id', 'in', ids).execute();
    try {
      const r = await userAdmin.post(`/api/v1/users/${root.id}/status`, { status: 'DISABLED', reason: 'Attempted lock-out of the last admin' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('LAST_ADMINISTRATOR');
      expect((await root.agent.get('/api/v1/users')).status).toBe(200); // rolled back, root still active
    } finally {
      if (ids.length) await app.db.updateTable('users').set({ status: 'ACTIVE' }).where('id', 'in', ids).execute();
      invalidatePrincipals();
    }
    // with another admin active the same action is allowed (then undone)
    const second = await createAdmin({ org: 'ksp' });
    const ok = await userAdmin.post(`/api/v1/users/${second.id}/status`, { status: 'DISABLED', reason: 'Allowed, others remain' });
    expect(ok.status).toBe(200);
  });

  it('keeps the audit chain intact', async () => {
    expect(await auditChainIntact()).toBe(true);
  });
});
