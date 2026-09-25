#!/usr/bin/env bash
# Full database restore for disaster recovery (idempotent). Object storage is NOT copied by this script: the restored
# database points at bucket names, so the DR object store must hold the replicated buckets under the same names
# (scripts/backup/s3-replicate.ts) and the services are started with S3_ENDPOINT pointing at it.
#
#   scripts/backup/restore.sh --admin-url <postgres://superuser@host:5432/postgres> [--database ksp]
#                             [--source latest|s3://bucket/…/manifest.json|/path/manifest.json] [--replace] [--jobs 4]
#
#   --admin-url  role with CREATEDB + CREATEROLE on the TARGET cluster (connects to the "postgres" database)
#   --replace    if the target database exists and is NOT already this backup, rename it to <db>_pre_restore_<ts>
#                (never dropped — it may be the only copy of newer evidence metadata) and restore
# Environment: BACKUP_AGE_IDENTITY_FILE (age private key, from the offline store), BACKUP_S3_* for s3:// / latest,
#   optional RESTORE_OWNER_DB_PASSWORD / RESTORE_APP_DB_PASSWORD / RESTORE_AI_DB_PASSWORD / RESTORE_BACKUP_DB_PASSWORD
#   to (re)set role passwords on a fresh cluster (use NEW values if the old ones may be compromised).
#
# Idempotency: re-running after success detects that the database already holds this backup (manifest audit head
# row + migrations) and exits 0 without changes; a failed run leaves only <db>_restoring, which the next run drops.
set -euo pipefail
# shellcheck source=scripts/backup/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ADMIN=""; DB=ksp; SRC=latest; REPLACE=0; JOBS=4
while [ $# -gt 0 ]; do
  case "$1" in
    --admin-url) ADMIN="$2"; shift 2 ;;
    --database) DB="$2"; shift 2 ;;
    --source) SRC="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$ADMIN" ] || die "--admin-url is required"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "invalid database name"
for t in pg_restore psql age sha256sum node; do command -v "$t" >/dev/null || die "missing tool: $t"; done
export PGOPTIONS="-c client_min_messages=warning"
dburl() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$ADMIN" "$1"; }
aq() { psql "$ADMIN" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
T0=$(date +%s)
WORK="${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/ksp-restore-$(date -u +%Y%m%d%H%M%S)-$$"
mkdir -p "$WORK"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT

# 1. Roles (cluster-wide, idempotent).
log "step 1/5: cluster roles"
pwargs=()
[ -n "${RESTORE_APP_DB_PASSWORD:-}" ] && pwargs+=(-v "app_password='$RESTORE_APP_DB_PASSWORD'")
[ -n "${RESTORE_AI_DB_PASSWORD:-}" ] && pwargs+=(-v "ai_password='$RESTORE_AI_DB_PASSWORD'")
psql "$ADMIN" -qX -v ON_ERROR_STOP=1 "${pwargs[@]}" -f "$REPO_ROOT/db/bootstrap/roles.sql" >/dev/null
aq "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_backup') THEN CREATE ROLE ksp_backup NOLOGIN; END IF; END \$\$" >/dev/null
[ -n "${RESTORE_OWNER_DB_PASSWORD:-}" ] && psql "$ADMIN" -qX -v ON_ERROR_STOP=1 -v pw="$RESTORE_OWNER_DB_PASSWORD" <<<"ALTER ROLE ksp_owner LOGIN PASSWORD :'pw'" >/dev/null
[ -n "${RESTORE_BACKUP_DB_PASSWORD:-}" ] && psql "$ADMIN" -qX -v ON_ERROR_STOP=1 -v pw="$RESTORE_BACKUP_DB_PASSWORD" <<<"ALTER ROLE ksp_backup LOGIN PASSWORD :'pw'; GRANT pg_read_all_data TO ksp_backup" >/dev/null

# 2. Fetch + verify + decrypt (before touching any database).
log "step 2/5: fetch and verify backup ($SRC)"
fetch_backup "$SRC" "$WORK"
decrypt_verify "$WORK/restore.dump"

# 3. Idempotency / safety checks on the target.
log "step 3/5: target database $DB"
if [ "$(aq "SELECT count(*) FROM pg_database WHERE datname = '$DB'")" = 1 ]; then
  mh=$(json "$MANIFEST" m.audit.headSeq); mhash=$(json "$MANIFEST" m.audit.headHash)
  have=$(psql "$(dburl "$DB")" -qtAX -c "SELECT hash FROM audit_events WHERE seq = $mh" 2>/dev/null || true)
  if [ -n "$have" ] && [ "$have" = "$mhash" ] && (post_checks "$(dburl "$DB")") 2>/dev/null; then
    log "database $DB already contains this backup (audit row $mh matches) and verifies — nothing to do"
    echo "RESTORE_OK (already restored) $BACKUP_SOURCE"
    exit 0
  fi
  [ "$REPLACE" = 1 ] || die "database $DB exists and is not this backup; re-run with --replace (it will be renamed, not dropped)"
  old="${DB}_pre_restore_$(date -u +%Y%m%d%H%M%S)"
  aq "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" >/dev/null
  aq "ALTER DATABASE \"$DB\" RENAME TO \"$old\"" >/dev/null
  log "existing database renamed to $old (kept for forensics)"
fi

# 4. Restore into <db>_restoring, then rename (a crash never leaves a half-restored database under the real name).
log "step 4/5: pg_restore (jobs=$JOBS)"
aq "DROP DATABASE IF EXISTS \"${DB}_restoring\" WITH (FORCE)" >/dev/null
aq "CREATE DATABASE \"${DB}_restoring\" OWNER ksp_owner" >/dev/null
T1=$(date +%s)
restore_dump "$WORK/restore.dump" "$(dburl "${DB}_restoring")" "$JOBS"
log "pg_restore finished in $(( $(date +%s) - T1 )) s"
post_checks "$(dburl "${DB}_restoring")"
aq "ALTER DATABASE \"${DB}_restoring\" RENAME TO \"$DB\"" >/dev/null
aq "REVOKE ALL ON DATABASE \"$DB\" FROM PUBLIC" >/dev/null
aq "GRANT CONNECT ON DATABASE \"$DB\" TO ksp_app, ksp_ai, ksp_backup" >/dev/null

# 5. Next steps (printed, not executed: they need the environment's secrets and the DR storage endpoint).
log "step 5/5: database restored in $(( $(date +%s) - T0 )) s total"
cat >&2 <<NEXT
Next (docs/BACKUP-RESTORE-RUNBOOK.md):
  a. migrate:            node packages/core/dist/bin/migrate.js      (applies migrations newer than the backup)
  b. storage:            S3_ENDPOINT=<DR store> node scripts/ops/ensure-buckets.mjs --check
  c. originals:          node scripts/backup/s3-replicate.ts --verify-only   (DB sha256 vs DR objects)
  d. start api/worker against the restored DB + DR storage; check /health/ready; log in; open evidence
  e. record the incident + restore in the audit trail / incident register; rotate secrets if compromise suspected
NEXT
echo "RESTORE_OK $BACKUP_SOURCE -> $DB"
