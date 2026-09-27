#!/usr/bin/env bash
# Prove a backup is restorable: fetch -> verify SHA-256 -> decrypt -> restore into a SCRATCH database ->
# schema_migrations vs repository -> audit_verify() -> manifest facts -> drop scratch DB. Exit 1 on any failure.
#
#   scripts/backup/verify-backup.sh [latest | s3://bucket/key/manifest.json | /path/manifest.json]
#
# Environment
#   VERIFY_ADMIN_URL          postgres URL of a role with CREATEDB on the verification cluster (database "postgres").
#                             Use a scratch cluster, never the production primary. The KSP roles (ksp_owner, ksp_app,
#                             ksp_ai) must exist there (db/bootstrap/roles.sql without passwords is enough).
#   BACKUP_AGE_IDENTITY_FILE  age private key (the verification job is the only non-restore holder of it)
#   BACKUP_SIGNING_PUBKEY_FILE  Ed25519 public key; when set the manifest signature is REQUIRED and verified (OPS-8)
#   BACKUP_S3_* / BACKUP_S3_BUCKET / BACKUP_S3_PREFIX   when the source is s3:// or latest
#   BACKUP_RECORD_URL         optional: record a VERIFY row in backup_runs of the production DB
#   VERIFY_KEEP_DB=1          keep the scratch database (debugging)
set -euo pipefail
# shellcheck source=scripts/backup/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SRC="${1:-latest}"
: "${VERIFY_ADMIN_URL:?VERIFY_ADMIN_URL is required}"
for t in pg_restore psql age sha256sum node openssl; do command -v "$t" >/dev/null || die "missing tool: $t"; done

TS="$(date -u +%Y%m%d%H%M%S)"
WORK="${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/ksp-verify-$TS-$$"
SCRATCH="ksp_verify_${TS}_$$"
mkdir -p "$WORK"; chmod 700 "$WORK"
RUN_ID=""
if [ -n "${BACKUP_RECORD_URL:-}" ]; then
  RUN_ID=$(psql "$BACKUP_RECORD_URL" -qtAX -c "INSERT INTO backup_runs (kind, status) VALUES ('VERIFY', 'RUNNING') RETURNING id" 2>/dev/null || true)
fi
finish() {
  local rc=$?
  if [ "${VERIFY_KEEP_DB:-0}" != 1 ]; then
    psql "$VERIFY_ADMIN_URL" -qtAX -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  if [ -n "$RUN_ID" ]; then
    local st=SUCCEEDED err=""
    [ "$rc" = 0 ] || { st=FAILED; err="verify-backup exited $rc (see job log)"; }
    psql "$BACKUP_RECORD_URL" -qtAX -v id="$RUN_ID" -v st="$st" -v err="$err" -v loc="${BACKUP_SOURCE:-$SRC}" \
      <<<"UPDATE backup_runs SET status = :'st', finished_at = now(), error = NULLIF(:'err',''), location = :'loc' WHERE id = :'id'::uuid" >/dev/null 2>&1 || true
  fi
  if [ "$rc" = 0 ]; then log "VERIFY_OK ${BACKUP_SOURCE:-$SRC}"; else log "VERIFY_FAILED ${BACKUP_SOURCE:-$SRC}"; fi
  exit "$rc"
}
trap finish EXIT

T0=$(date +%s)
fetch_backup "$SRC" "$WORK"
decrypt_verify "$WORK/restore.dump"
psql "$VERIFY_ADMIN_URL" -qtAX -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH\"" >/dev/null || die "cannot create scratch database"
SCRATCH_URL=$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$VERIFY_ADMIN_URL" "$SCRATCH")
restore_dump "$WORK/restore.dump" "$SCRATCH_URL" "${RESTORE_JOBS:-4}"
log "restored into scratch database $SCRATCH in $(( $(date +%s) - T0 )) s"
post_checks "$SCRATCH_URL"
log "verification completed in $(( $(date +%s) - T0 )) s"
