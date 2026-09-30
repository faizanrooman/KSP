import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';

beforeAll(evidenceTestSetup);
afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('directory org units scope', () => {
  it('without scope lists every active unit; with scope only units inside the caller jurisdiction for that permission', async () => {
    const meera = await login('io.meera'); // IO at ps_cubbonpark
    const all = (await meera.get('/api/v1/directory/org-units')).body.items as Array<{ code: string }>;
    expect(all.map((u) => u.code)).toEqual(expect.arrayContaining(['ksp', 'ps_cubbonpark', 'ps_indiranagar']));
    const scoped = await meera.get('/api/v1/directory/org-units?scope=dashboard:view');
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((u: { code: string }) => u.code)).toEqual(['ps_cubbonpark']);
    // A permission she does not hold anywhere -> empty list, not an error.
    expect((await meera.get('/api/v1/directory/org-units?scope=users:manage')).body.items).toEqual([]);
  });

  it('a state-level grant covers the whole tree; unknown permissions are rejected', async () => {
    const aud = await createUser({ role: 'AUDITOR', org: 'ksp' });
    const a = await login(aud.username, aud.password);
    const scoped = (await a.get('/api/v1/directory/org-units?scope=dashboard:view')).body.items as Array<{ code: string }>;
    expect(scoped.map((u) => u.code)).toEqual(expect.arrayContaining(['ksp', 'ps_cubbonpark', 'ps_nazarbad']));
    expect((await a.get('/api/v1/directory/org-units?scope=not:a_permission')).status).toBe(400);
  });
});
