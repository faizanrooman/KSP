-- KSP VMS database role bootstrap. Run ONCE per cluster by a DBA / superuser, BEFORE migrations.
--   psql -v app_password='<raw>' -v ai_password='<raw>' -f db/bootstrap/roles.sql   (raw values; psql quotes them via :'var')
--
-- Roles:
--   ksp_owner  owns the schema; used ONLY by the migration runner.
--   ksp_app    used by the API and the main worker. DML only; cannot alter schema, cannot UPDATE/DELETE audit rows.
--   ksp_ai     used by the isolated AI worker. Can read only derived-media metadata and write AI results.
--              It has NO access to evidence storage keys, users, audit tampering, etc.

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE ksp_owner NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_owner') \gexec
SELECT 'CREATE ROLE ksp_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_app') \gexec
SELECT 'CREATE ROLE ksp_ai LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_ai') \gexec

\if :{?app_password}
ALTER ROLE ksp_app PASSWORD :'app_password';
\endif
\if :{?ai_password}
ALTER ROLE ksp_ai PASSWORD :'ai_password';
\endif
