#!/usr/bin/env bash
# Encrypted logical backup of the KSP database to the (separate, Object-Lock) backup bucket.
#
#   scripts/backup/pg-backup.sh [--local-only <dir>]
#
# Steps: pg_dump -Fc  ->  pg_restore --list (TOC sanity)  ->  SHA-256 of the dump  ->  age encryption to the
# recipients (public keys only on this host)  ->  SHA-256 of the ciphertext  ->  manifest.json  ->  upload both with
# GOVERNANCE retention  ->  backup_runs row  ->  prune versions older than BACKUP_RETENTION_DAYS (the store refuses
# to delete anything still under Object Lock; such versions are reported and kept).
#
# Environment
#   PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD   source database (role ksp_backup = pg_read_all_data; a replica is fine)
#   BACKUP_AGE_RECIPIENTS_FILE                   age recipients (public keys), one per line — REQUIRED
#   BACKUP_S3_ENDPOINT/_REGION/_ACCESS_KEY/_SECRET_KEY, BACKUP_S3_BUCKET   backup store (other site)
#   BACKUP_S3_PREFIX      default pg/<PGDATABASE>
#   BACKUP_LOCK_DAYS      Object Lock retention for backup objects (default = BACKUP_RETENTION_DAYS)
#   BACKUP_RETENTION_DAYS default 35
#   BACKUP_RECORD_URL     postgres URL (ksp_app) used to insert the backup_runs row (optional but recommended)
#   BACKUP_WORK_DIR       scratch directory (default: mktemp under TMPDIR); must hold dump + ciphertext
#   BACKUP_JOBS           unused for -Fc (single stream); kept for pg_basebackup variants
# Output: prints the manifest key on success (last line: "BACKUP_OK <bucket>/<key>").
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_ONLY=""
[ "${1:-}" = "--local-only" ] && LOCAL_ONLY="${2:?--local-only <dir>}"

: "${PGDATABASE:?PGDATABASE is required}"
: "${BACKUP_AGE_RECIPIENTS_FILE:?BACKUP_AGE_RECIPIENTS_FILE (age public keys) is required}"
[ -s "$BACKUP_AGE_RECIPIENTS_FILE" ] || { echo "recipients file $BACKUP_AGE_RECIPIENTS_FILE is empty" >&2; exit 1; }
for t in pg_dump pg_restore psql age sha256sum node; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
RETENTION="${BACKUP_RETENTION_DAYS:-35}"
LOCK_DAYS="${BACKUP_LOCK_DAYS:-$RETENTION}"
PREFIX="${BACKUP_S3_PREFIX:-pg/$PGDATABASE}"
if [ -z "$LOCAL_ONLY" ]; then : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"; fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/ksp-backup-$TS-$$"
mkdir -p "$WORK"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
NAME="ksp-$PGDATABASE-$TS"
DUMP="$WORK/$NAME.dump"
ENC="$DUMP.age"
START_EPOCH=$(date +%s)
RUN_ID=""

record() { # status [size sha location error]
  [ -n "${BACKUP_RECORD_URL:-}" ] || return 0
  if [ -z "$RUN_ID" ]; then
    RUN_ID=$(psql "$BACKUP_RECORD_URL" -qtAX -v ON_ERROR_STOP=1 -c "INSERT INTO backup_runs (kind, status) VALUES ('PG_DUMP', 'RUNNING') RETURNING id") || { echo "WARN: could not record backup_runs" >&2; RUN_ID=""; return 0; }
    return 0
  fi
  psql "$BACKUP_RECORD_URL" -qtAX -v ON_ERROR_STOP=1 \
    -v id="$RUN_ID" -v st="$1" -v sz="${2:-}" -v sha="${3:-}" -v loc="${4:-}" -v err="${5:-}" \
    <<<"UPDATE backup_runs SET status = :'st', finished_at = now(), size_bytes = NULLIF(:'sz','')::bigint, sha256 = NULLIF(:'sha',''), location = NULLIF(:'loc',''), error = NULLIF(:'err','') WHERE id = :'id'::uuid" >/dev/null \
    || echo "WARN: could not update backup_runs $RUN_ID" >&2
}
fail() { echo "BACKUP_FAILED: $1" >&2; record FAILED "" "" "" "$1"; exit 1; }
record RUNNING

# 1. Facts recorded in the manifest, taken BEFORE the dump snapshot: the restored database must contain at least
#    these rows and the audit row headSeq must carry exactly headHash (append-only ledger => prefix is immutable).
q() { psql -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
SERVER_VERSION=$(q "SHOW server_version")
MIG_HEAD=$(q "SELECT coalesce(max(version),'') FROM schema_migrations")
MIG_COUNT=$(q "SELECT count(*) FROM schema_migrations")
AUDIT_HEAD=$(q "SELECT coalesce(max(seq),0) FROM audit_events")
AUDIT_HASH=$(q "SELECT coalesce((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),'')")
EVIDENCE_ROWS=$(q "SELECT count(*) FROM evidence")
USER_ROWS=$(q "SELECT count(*) FROM users")
# Database-level settings (ALTER DATABASE ... SET, e.g. jit=off from migration 0901) are NOT in a -Fc dump of one
# database; record them so restore.sh re-applies them.
DB_SETTINGS=$(q "SELECT coalesce(json_agg(c), '[]') FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())")

# 2. Dump (custom format, compressed). Snapshot-consistent by construction (single transaction).
pg_dump --format=custom --compress=6 --no-password --file="$DUMP" || fail "pg_dump exited $?"
pg_restore --list "$DUMP" > "$WORK/toc.txt" || fail "pg_restore --list could not read the dump"
grep -q "TABLE DATA public audit_events" "$WORK/toc.txt" || fail "dump does not contain audit_events data"

# 3. Hash, encrypt, hash.
PLAIN_SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
PLAIN_SIZE=$(stat -c %s "$DUMP")
age --encrypt --recipients-file "$BACKUP_AGE_RECIPIENTS_FILE" --output "$ENC" "$DUMP" || fail "age encryption failed"
rm -f "$DUMP"
ENC_SHA=$(sha256sum "$ENC" | cut -d' ' -f1)
ENC_SIZE=$(stat -c %s "$ENC")
KEY="$PREFIX/$TS/$NAME.dump.age"
MKEY="$PREFIX/$TS/manifest.json"
cat > "$WORK/manifest.json" <<JSON
{
  "format": "ksp-pg-backup/v1",
  "createdAt": "$(date -u +%FT%TZ)",
  "database": "$PGDATABASE",
  "serverVersion": "$SERVER_VERSION",
  "pgDumpVersion": "$(pg_dump --version | awk '{print $3}')",
  "encryption": "age (X25519 recipients)",
  "object": "$KEY",
  "plainSha256": "$PLAIN_SHA",
  "plainSizeBytes": $PLAIN_SIZE,
  "encryptedSha256": "$ENC_SHA",
  "encryptedSizeBytes": $ENC_SIZE,
  "schemaMigrations": { "count": $MIG_COUNT, "head": "$MIG_HEAD" },
  "audit": { "headSeq": $AUDIT_HEAD, "headHash": "$AUDIT_HASH" },
  "rowCounts": { "evidence": $EVIDENCE_ROWS, "users": $USER_ROWS },
  "databaseSettings": $DB_SETTINGS
}
JSON

if [ -n "$LOCAL_ONLY" ]; then
  mkdir -p "$LOCAL_ONLY/$TS"
  cp "$ENC" "$WORK/manifest.json" "$LOCAL_ONLY/$TS/"
  record SUCCEEDED "$ENC_SIZE" "$ENC_SHA" "file:$LOCAL_ONLY/$TS/$NAME.dump.age"
  echo "BACKUP_OK file:$LOCAL_ONLY/$TS/manifest.json"
  exit 0
fi

# 4. Upload (ciphertext first, manifest last = commit marker), with Object Lock retention.
node "$HERE/s3.ts" ensure-bucket "$BACKUP_S3_BUCKET" --lock >/dev/null || fail "backup bucket unavailable"
node "$HERE/s3.ts" put "$BACKUP_S3_BUCKET" "$KEY" "$ENC" --lock-days "$LOCK_DAYS" >/dev/null || fail "upload of $KEY failed"
node "$HERE/s3.ts" put "$BACKUP_S3_BUCKET" "$MKEY" "$WORK/manifest.json" --lock-days "$LOCK_DAYS" >/dev/null || fail "upload of manifest failed"
REMOTE_SIZE=$(node "$HERE/s3.ts" head "$BACKUP_S3_BUCKET" "$KEY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).size))')
[ "$REMOTE_SIZE" = "$ENC_SIZE" ] || fail "uploaded size $REMOTE_SIZE != local $ENC_SIZE"
record SUCCEEDED "$ENC_SIZE" "$ENC_SHA" "s3://$BACKUP_S3_BUCKET/$KEY"

# 5. Retention (best effort; never fails a successful backup).
node "$HERE/s3.ts" prune "$BACKUP_S3_BUCKET" "$PREFIX/" "$RETENTION" 2>/dev/null || echo "WARN: prune failed" >&2

echo "backup $NAME: dump ${PLAIN_SIZE} B, encrypted ${ENC_SIZE} B, audit head ${AUDIT_HEAD}, $(( $(date +%s) - START_EPOCH )) s"
echo "BACKUP_OK s3://$BACKUP_S3_BUCKET/$MKEY"
