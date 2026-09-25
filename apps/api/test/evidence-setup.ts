/** Shared setup for evidence/retention tests: MFA policy relaxed for MFA-mandatory roles, queue on the owner connection. */
import { getQueue, loadConfig, stopQueue } from '@ksp/core';
import { getApp } from './helpers.js';
import { invalidateSettings } from '../src/lib/settings.js';

export async function evidenceTestSetup() {
  const app = await getApp();
  await app.db
    .insertInto('system_settings')
    .values({ key: 'sessionPolicy', value: JSON.stringify({ requireMfaForRoles: [] }) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify({ requireMfaForRoles: [] }) }))
    .execute();
  invalidateSettings();
  // pg-boss must create/own its schema; the app role (DML only) cannot, so tests start it with the owner URL.
  await getQueue(loadConfig().DATABASE_MIGRATION_URL);
  return app;
}

export async function evidenceTestTeardown() {
  await stopQueue();
}

export async function userId(username: string): Promise<string> {
  const app = await getApp();
  return (await app.db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow()).id;
}
