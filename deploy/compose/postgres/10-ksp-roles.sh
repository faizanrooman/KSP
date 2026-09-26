#!/usr/bin/env bash
# First-start initialisation of the compose PostgreSQL cluster (runs once, on an empty data directory).
# Creates the KSP roles with passwords from Docker secrets and makes ksp_owner (LOGIN) own the database, so
# migrations never run as a superuser. Same logic as scripts/ops/bootstrap-db.sh (used for managed clusters).
set -euo pipefail
s() { tr -d '\n' < "/run/secrets/$1"; }
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v app_password="$(s ksp_app_db_password)" -v ai_password="$(s ksp_ai_db_password)" -f /ksp/roles.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v owner_password="'$(s ksp_owner_db_password)'" -v backup_password="'$(s ksp_backup_db_password)'" \
  -v db="$POSTGRES_DB" <<'SQL'
ALTER ROLE ksp_owner LOGIN PASSWORD :owner_password;
SELECT 'CREATE ROLE ksp_backup LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_backup') \gexec
ALTER ROLE ksp_backup PASSWORD :backup_password;
GRANT pg_read_all_data TO ksp_backup;
ALTER DATABASE :"db" OWNER TO ksp_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO ksp_app, ksp_ai, ksp_backup;
SQL
