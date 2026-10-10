/** Shared setup for evidence/retention tests: MFA policy relaxed for MFA-mandatory roles, queue on the owner connection. */
import { getQueue, stopQueue } from '@ksp/core';
import { getApp } from './helpers.js';
import { invalidateSettings } from '../src/lib/settings.js';

export async function evidenceTestSetup() {
  const app = await getApp();
  await app.db
    .insertInto('system_settings')
    .values({ key: 'sessionPolicy', value: JSON.stringify({ requireMfaForRoles: [], mfaForPrivilegedPermissions: false }) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify({ requireMfaForRoles: [], mfaForPrivilegedPermissions: false }) }))
    .execute();
  invalidateSettings();
  // pg-boss must create/own its schema; the app role (DML only) cannot, so tests start it with the owner URL.
  await getQueue();
  return app;
}

export async function evidenceTestTeardown() {
  // Restore the default session policy for other test files sharing the test database.
  const app = await getApp();
  await app.db.deleteFrom('system_settings').where('key', '=', 'sessionPolicy').execute();
  invalidateSettings();
  await stopQueue();
}

export async function userId(username: string): Promise<string> {
  const app = await getApp();
  return (await app.db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow()).id;
}
