import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@ksp/shared';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { auditChainIntact, createAdmin, lastAudit, type AdminSession } from './admin-helpers.js';
import { clearLoginFailures } from './admin-helpers.js';
import { invalidateSettings } from '../src/lib/settings.js';

const S = '/api/v1/settings';
let root: AdminSession;

beforeAll(async () => {
  root = await createAdmin({ org: 'ksp' });
});
afterAll(async () => {
  // Leave the shared test database on defaults for other files.
  const app = await getApp();
  await app.db.deleteFrom('system_settings').execute();
  invalidateSettings();
  await closeApp();
});

describe('settings', () => {
  it('401 / 403 / effective settings', async () => {
    expect((await new Agent(await getApp()).get(S)).status).toBe(401);
    const io = await login('io.meera');
    expect((await io.get(S)).status).toBe(403);
    expect((await io.put(`${S}/lockoutPolicy`, DEFAULT_SETTINGS.lockoutPolicy)).status).toBe(403);
    const station = await createAdmin({ org: 'ps_cubbonpark' }); // settings:manage is jurisdiction-independent
    const r = await station.agent.get(S);
    expect(r.status).toBe(200);
    expect(r.body.settings.passwordPolicy).toEqual(DEFAULT_SETTINGS.passwordPolicy);
    expect(r.body.keys.map((k: { key: string }) => k.key)).toContain('sessionPolicy');
  });

  it('validates per key with bounds and cross-field rules', async () => {
    const bad = async (key: string, v: unknown) => (await root.agent.put(`${S}/${key}`, v)).status;
    expect(await bad('noSuchKey', {})).toBe(400);
    expect(await bad('passwordPolicy', { ...DEFAULT_SETTINGS.passwordPolicy, minLength: 4 })).toBe(400);
    expect(await bad('passwordPolicy', { ...DEFAULT_SETTINGS.passwordPolicy, extra: true })).toBe(400);
    expect(await bad('passwordPolicy', { minLength: 14 })).toBe(400); // whole object required
    expect(await bad('lockoutPolicy', { ...DEFAULT_SETTINGS.lockoutPolicy, maxFailedAttempts: 0 })).toBe(400);
    expect(await bad('sessionPolicy', { ...DEFAULT_SETTINGS.sessionPolicy, idleTimeoutMinutes: 300, absoluteTimeoutHours: 2 })).toBe(400);
    expect(await bad('sessionPolicy', { ...DEFAULT_SETTINGS.sessionPolicy, requireMfaForRoles: ['NO_SUCH_ROLE'] })).toBe(400);
    expect(await bad('storagePolicy', { ...DEFAULT_SETTINGS.storagePolicy, warnThresholdPercent: 90, criticalThresholdPercent: 80 })).toBe(400);
    expect(await bad('uploadPolicy', { ...DEFAULT_SETTINGS.uploadPolicy, chunkSizeBytes: 1024 })).toBe(400);
    expect(await bad('shareExportPolicy', { ...DEFAULT_SETTINGS.shareExportPolicy, maxShareDays: 'x' })).toBe(400);
  });

  it('updates a key (audited old/new) and the change takes effect immediately', async () => {
    const r = await root.agent.put(`${S}/lockoutPolicy`, { ...DEFAULT_SETTINGS.lockoutPolicy, maxFailedAttempts: 3 });
    expect(r.status).toBe(200);
    expect(r.body.settings.lockoutPolicy.maxFailedAttempts).toBe(3);
    expect(r.body.keys.find((k: { key: string }) => k.key === 'lockoutPolicy')).toMatchObject({ overridden: true, updatedBy: { id: root.id } });
    const ev = await lastAudit('SETTINGS_UPDATED');
    expect(ev?.details).toMatchObject({ key: 'lockoutPolicy', old: { maxFailedAttempts: 5 }, new: { maxFailedAttempts: 3 } });
    // enforced by the login flow right away
    const u = await createUser({ role: 'FIELD_OFFICER', org: 'ps_cubbonpark' });
    const app = await getApp();
    for (let i = 0; i < 3; i++) await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: 'wrong-password' });
    expect((await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: u.password })).status).toBe(423);
    await clearLoginFailures();
    // reset to default
    const del = await root.agent.delete(`${S}/lockoutPolicy`);
    expect(del.status).toBe(200);
    expect(del.body.settings.lockoutPolicy).toEqual(DEFAULT_SETTINGS.lockoutPolicy);
    expect((await root.agent.delete(`${S}/lockoutPolicy`)).status).toBe(404);
    expect((await lastAudit('SETTINGS_UPDATED'))?.details).toMatchObject({ reset: true });
  });

  it('MFA-mandatory role list changes apply to live sessions', async () => {
    const fa = await createUser({ role: 'FORENSIC_ANALYST', org: 'blr_city' });
    const a = await login(fa.username, fa.password);
    expect((await a.get('/api/v1/auth/sessions')).status).toBe(200);
    const r = await root.agent.put(`${S}/sessionPolicy`, { ...DEFAULT_SETTINGS.sessionPolicy, requireMfaForRoles: [...DEFAULT_SETTINGS.sessionPolicy.requireMfaForRoles, 'FORENSIC_ANALYST'] });
    expect(r.status).toBe(200);
    const blocked = await a.get('/api/v1/auth/sessions');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    await root.agent.delete(`${S}/sessionPolicy`);
    expect((await a.get('/api/v1/auth/sessions')).status).toBe(200);
    expect(await auditChainIntact()).toBe(true);
  });
});
