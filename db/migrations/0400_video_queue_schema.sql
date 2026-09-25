-- 0400: pg-boss schema for the durable job queue (MEDIA_PROCESS and every other queue).
-- The application role (ksp_app) has no CREATE privilege on the database, so pg-boss cannot create its own
-- schema on first start. Pre-create it owned by ksp_app so pg-boss can create/upgrade its tables inside it.
-- Idempotent: other workstreams may ship an equivalent statement.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    CREATE SCHEMA pgboss AUTHORIZATION ksp_app;
  END IF;
  -- pg-boss always issues `CREATE SCHEMA IF NOT EXISTS pgboss` on start, and PostgreSQL checks the
  -- database-level CREATE privilege before the existence test. Grant it (schema creation only; ksp_app
  -- still owns no public-schema objects). See docs/VIDEO-PIPELINE.md "Queue schema".
  EXECUTE format('GRANT CREATE ON DATABASE %I TO ksp_app', current_database());
END $$;
