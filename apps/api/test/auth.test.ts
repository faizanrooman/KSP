import { afterAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { REFRESH_COOKIE } from '@ksp/shared';
import { Agent, closeApp, createUser, getApp, login, nextTotp } from './helpers.js';

afterAll(closeApp);

describe('authentication', () => {
  it('logs in with valid credentials and returns permissions', async () => {
    const a = await login('io.meera');
    const me = await a.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('io.meera');
    expect(me.body.permissions).toContain('evidence:read');
    expect(me.body.permissions).not.toContain('users:manage');
  });

  it('rejects bad password and unknown user with the same generic error', async () => {
    const app = await getApp();
    const bad = await new Agent(app).post('/api/v1/auth/login', { username: 'io.meera', password: 'nope' });
    const unknown = await new Agent(app).post('/api/v1/auth/login', { username: 'no.such.user', password: 'nope' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('requires authentication for protected routes', async () => {
    const app = await getApp();
    const r = await new Agent(app).get('/api/v1/auth/sessions');
    expect(r.status).toBe(401);
  });

  it('rejects forged / tampered access tokens', async () => {
    const app = await getApp();
    const r = await new Agent(app).request('GET', '/api/v1/auth/me', { headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } });
    expect(r.status).toBe(401);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const app = await getApp();
    for (let i = 0; i < 5; i++) await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: 'wrong-password' });
    const r = await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: u.password });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('enforces CSRF double-submit on cookie-authenticated unsafe requests', async () => {
    const a = await login('io.meera');
    const noHeader = await a.request('POST', '/api/v1/auth/logout', { body: {}, headers: { 'x-csrf-token': 'forged' } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF_FAILED');
    const ok = await a.post('/api/v1/auth/logout');
    expect(ok.status).toBe(200);
  });

  it('revokes the session on logout (token no longer accepted)', async () => {
    const app = await getApp();
    const res = await new Agent(app).post('/api/v1/auth/login', { username: 'io.arjun', password: 'Ksp@Dev-Passw0rd!', tokenMode: 'bearer' });
    const token = res.body.accessToken as string;
    const auth = { authorization: `Bearer ${token}` };
    expect((await new Agent(app).request('GET', '/api/v1/auth/me', { headers: auth })).status).toBe(200);
    expect((await new Agent(app).request('POST', '/api/v1/auth/logout', { body: {}, headers: auth })).status).toBe(200);
    expect((await new Agent(app).request('GET', '/api/v1/auth/me', { headers: auth })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const app = await getApp();
    const res = await new Agent(app).post('/api/v1/auth/login', { username: 'io.arjun', password: 'Ksp@Dev-Passw0rd!', tokenMode: 'bearer' });
    const r1 = res.body.refreshToken as string;
    const rot = await new Agent(app).post('/api/v1/auth/refresh', { refreshToken: r1 });
    expect(rot.status).toBe(200);
    const r2 = rot.body.refreshToken as string;
    expect(r2).not.toBe(r1);
    // replay the consumed token => theft signal
    const replay = await new Agent(app).post('/api/v1/auth/refresh', { refreshToken: r1 });
    expect(replay.status).toBe(401);
    // the legitimate successor is now dead too, and so is the access token
    expect((await new Agent(app).post('/api/v1/auth/refresh', { refreshToken: r2 })).status).toBe(401);
    expect((await new Agent(app).request('GET', '/api/v1/auth/me', { headers: { authorization: `Bearer ${rot.body.accessToken}` } })).status).toBe(401);
  });

  it('refreshes via httpOnly cookie for browser sessions', async () => {
    const a = await login('io.meera');
    expect(a.cookies.get(REFRESH_COOKIE)).toBeTruthy();
    const r = await a.post('/api/v1/auth/refresh');
    expect(r.status).toBe(200);
  });

  it('forces password change before other routes when flagged, and enforces policy + history', async () => {
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark', mustChange: true });
    const a = await login(u.username, u.password);
    const blocked = await a.get('/api/v1/auth/sessions');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const weak = await a.post('/api/v1/auth/password/change', { currentPassword: u.password, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const reuse = await a.post('/api/v1/auth/password/change', { currentPassword: u.password, newPassword: u.password });
    expect(reuse.status).toBe(400);
    const ok = await a.post('/api/v1/auth/password/change', { currentPassword: u.password, newPassword: 'N3w-Strong-Passphrase!' });
    expect(ok.status).toBe(200);
    expect((await a.get('/api/v1/auth/sessions')).status).toBe(200);
  });

  it('enrols TOTP MFA and then requires a second factor at login', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const a = await login(u.username, u.password);
    const setup = await a.post('/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const confirm = await a.post('/api/v1/auth/mfa/confirm', { code: authenticator.generate(setup.body.secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    const app = await getApp();
    const b = new Agent(app);
    const step1 = await b.post('/api/v1/auth/login', { username: u.username, password: u.password });
    expect(step1.body.mfaRequired).toBe(true);
    expect(b.cookies.size).toBe(0);
    const badCode = await b.post('/api/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, code: '000000' });
    expect(badCode.status).toBe(401);
    const step2 = await b.post('/api/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, code: await nextTotp(setup.body.secret, u.username) });
    expect(step2.status).toBe(200);
    expect(step2.body.me.user.mfaEnabled).toBe(true);

    // one-time recovery code works exactly once
    const c = new Agent(app);
    const s1 = await c.post('/api/v1/auth/login', { username: u.username, password: u.password });
    const code = confirm.body.recoveryCodes[0];
    expect((await c.post('/api/v1/auth/mfa/verify', { mfaToken: s1.body.mfaToken, recoveryCode: code })).status).toBe(200);
    const d = new Agent(app);
    const s2 = await d.post('/api/v1/auth/login', { username: u.username, password: u.password });
    expect((await d.post('/api/v1/auth/mfa/verify', { mfaToken: s2.body.mfaToken, recoveryCode: code })).status).toBe(401);
  });

  it('requires MFA enrolment for roles configured as MFA-mandatory', async () => {
    const u = await createUser({ role: 'SUPERVISOR', org: 'blr_central' });
    const a = await login(u.username, u.password);
    const r = await a.get('/api/v1/auth/sessions');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await a.get('/api/v1/auth/me')).body.user.mfaEnrollmentRequired).toBe(true);
  });

  it('writes an intact audit chain for auth events', async () => {
    const app = await getApp();
    const { rows } = await app.pool.query('SELECT checked, first_bad_seq FROM audit_verify()');
    expect(Number(rows[0].checked)).toBeGreaterThan(10);
    expect(rows[0].first_bad_seq).toBeNull();
  });
});
