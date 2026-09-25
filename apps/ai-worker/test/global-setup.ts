/** Rebuild the test database from migrations + dev seed before the suite. Uses .env.test (ksp_test DB, ksptest-* buckets). */
import pg from 'pg';

export default async function setup() {
  process.env.NODE_ENV = 'test';
  const core = await import('@ksp/core');
  core.resetConfigCache();
  const cfg = core.loadConfig();
  const admin = new pg.Client({ connectionString: cfg.DATABASE_MIGRATION_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await core.migrate(undefined, () => undefined);
  const { seedDev } = await import('@ksp/core/dev-seed');
  const { db } = core.createDb(cfg.DATABASE_URL, 4);
  await new core.Storage().ensureBuckets();
  await seedDev(db);
  await db.destroy();
}
