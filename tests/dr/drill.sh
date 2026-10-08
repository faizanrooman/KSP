#!/usr/bin/env bash
# shellcheck disable=SC2016  # node -e programs are single-quoted on purpose (JS template literals)
# End-to-end disaster-recovery drill (small data, local). Measures the wall-clock time of every step.
#
#   tests/dr/drill.sh [--files N] [--seconds S] [--keep]
#
# 1 provision   isolated drill DB + primary buckets; migrate + seed with the BUILT (dist) entrypoints
# 2 start       API + worker from production-only image layouts (scripts/ci/simulate-image.sh), NODE_ENV=production
# 3 ingest      N FFmpeg-generated videos uploaded with the station client; wait REGISTERED + media READY
# 4 backup      scripts/backup/pg-backup.sh -> age-encrypted dump in an Object-Lock bucket on the DR object store
# 5 replicate   scripts/backup/s3-replicate.ts primary -> DR store (originals SHA-256-checked against the DB)
# 6 verify      scripts/backup/verify-backup.sh (scratch restore, migrations, audit_verify, manifest facts)
#   DISASTER    stop services, DROP the database; the primary object store is no longer used
# 7 restore     scripts/backup/restore.sh from the DR backup bucket
# 8 repoint     s3-replicate.ts --repoint (version ids of the DR copies, custody-audited)
# 9 recover     API + worker against restored DB + DR store; /health/ready
# 10 validate   login, evidence list/detail/playback, on-demand fixity of every original FROM THE DR COPY,
#               s3-replicate --verify-only, audit_verify() on the restored DB
# Cleanup drops the drill databases and deletes every drill object/bucket (governance bypass) unless --keep.
#
# Requirements (dev host): the checkout's .env (keys/role passwords), `npm run build` done, PostgreSQL on
# PGADMIN_URL, primary S3 (versitygw) on PRIMARY_S3_ENDPOINT with root credentials, `versitygw` + ffmpeg + age on
# PATH (a second gateway is started as the DR store on DR_S3_PORT), pg client tools.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FILES=3; SECONDS_PER=8; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --files) FILES="$2"; shift 2 ;;
    --seconds) SECONDS_PER="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --ci) shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
PGADMIN_URL="${PGADMIN_URL:-postgres://ksp@127.0.0.1:5433/postgres}"
PRIMARY_S3_ENDPOINT="${PRIMARY_S3_ENDPOINT:-http://127.0.0.1:7480}"
S3_ROOT_ACCESS="${S3_ROOT_ACCESS:-kspdevaccess}"; S3_ROOT_SECRET="${S3_ROOT_SECRET:-kspdevsecret-change-me}"
DR_S3_PORT="${DR_S3_PORT:-7581}"; API_PORT="${DRILL_API_PORT:-4191}"; METRICS_PORT="${DRILL_METRICS_PORT:-9791}"
DB=ksp_drill_$$; BP=kdrill$$
BASE="${DRILL_DIR:-${TMPDIR:-/tmp}}/ksp-dr-drill-$$"
mkdir -p "$BASE"/{logs,work,dr-s3/buckets,dr-s3/versions,dr-s3/sidecar,media,backup-work}
REPORT="$BASE/report.tsv"; : > "$REPORT"
PIDS=()
log() { printf '%s [drill] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
now_ms() { date +%s%3N; }
step_start() { STEP_NAME="$1"; STEP_T=$(now_ms); log "step: $1"; }
step_end() { local ms=$(( $(now_ms) - STEP_T )); printf '%s\t%s\t%s\n' "$STEP_NAME" "$ms" "${1:-}" >> "$REPORT"; log "done: $STEP_NAME in ${ms} ms ${1:-}"; }
for t in node psql pg_dump pg_restore age age-keygen ffmpeg versitygw curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
[ -f "$ROOT/.env" ] || { echo "no .env in $ROOT" >&2; exit 1; }
[ -f "$ROOT/apps/api/dist/server.js" ] || { echo "run npm run build first" >&2; exit 1; }

envval() { grep -E "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2-; }
APP_URL_BASE=$(envval DATABASE_URL | sed -E 's#/[^/]+$##')      # postgres://ksp_app:pw@host:port
AI_URL_BASE=$(envval DATABASE_AI_URL | sed -E 's#/[^/]+$##')
ADMIN_BASE=$(sed -E 's#/[^/]+$##' <<<"$PGADMIN_URL")

# write_env <file> <s3-endpoint>: production-mode config for the drill services (NODE_ENV=production).
write_env() {
  {
    grep -E '^(JWT_PRIVATE_KEY|JWT_PUBLIC_KEY|DATA_ENCRYPTION_KEY|MEDIA_TOKEN_SECRET|SIGNING_PRIVATE_KEY|SIGNING_CERTIFICATE|SIGNING_KEY_ID|FFMPEG_PATH|FFPROBE_PATH)=' "$ROOT/.env"
    cat <<ENV
NODE_ENV=production
# The drill exercises production image layouts on a throwaway stack with CI keys/seed: run as the test tier so the
# production preflight reports its violations (dev signing key, http URLs, seed users…) instead of refusing to start.
KSP_ENVIRONMENT=test
KSP_PREFLIGHT=warn
COOKIE_SECURE=true
LOG_LEVEL=warn
API_PORT=$API_PORT
API_HOST=127.0.0.1
METRICS_PORT=$METRICS_PORT
METRICS_HOST=127.0.0.1
APP_BASE_URL=http://127.0.0.1:$API_PORT
CORS_ORIGINS=http://127.0.0.1:$API_PORT
DATABASE_URL=$APP_URL_BASE/$DB
DATABASE_MIGRATION_URL=$ADMIN_BASE/$DB
DATABASE_AI_URL=$AI_URL_BASE/$DB
S3_ENDPOINT=$2
S3_ACCESS_KEY=$S3_ROOT_ACCESS
S3_SECRET_KEY=$S3_ROOT_SECRET
S3_FORCE_PATH_STYLE=true
S3_BUCKET_STAGING=$BP-staging
S3_BUCKET_EVIDENCE=$BP-evidence
S3_BUCKET_ARCHIVE=$BP-archive
S3_BUCKET_LONG_TERM=$BP-longterm
S3_BUCKET_DERIVED=$BP-derived
S3_BUCKET_EXPORTS=$BP-exports
S3_BUCKET_REPORTS=$BP-reports
OBJECT_LOCK_MODE=GOVERNANCE
OBJECT_LOCK_DAYS=1
WORK_DIR=$BASE/work
WORKER_CONCURRENCY=2
ENV
  } > "$1"
}
DR_S3_ENDPOINT="http://127.0.0.1:$DR_S3_PORT"
write_env "$BASE/primary.env" "$PRIMARY_S3_ENDPOINT"
write_env "$BASE/dr.env" "$DR_S3_ENDPOINT"

start_svc() { # name layout-dir envfile cmd...
  local name="$1" dir="$2" envf="$3"; shift 3
  # Background ONLY the setsid command (not the `cd && …` list): otherwise $! can be an intermediate subshell, stop_svc
  # kills that shell and the service survives (seen in the final audit: stale primary API answered the DR health check).
  (cd "$dir" && { KSP_ENV_FILE="$envf" setsid "$@" > "$BASE/logs/$name.log" 2>&1 & echo $! > "$BASE/$name.pid"; })
  PIDS+=("$(cat "$BASE/$name.pid")")
}
stop_svc() { local f="$BASE/$1.pid" p; [ -f "$f" ] || return 0; p=$(cat "$f")
  kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done
  kill -KILL -- -"$p" 2>/dev/null || true; rm -f "$f"; }
wait_ready() { for _ in $(seq 1 120); do curl -fs "http://127.0.0.1:$API_PORT/health/ready" >/dev/null && return 0; sleep 0.5; done
  tail -50 "$BASE/logs/api.log" >&2; return 1; }

# Tool environments (never exported globally so the drill services only see their env file).
S3ENV_PRIMARY=(S3_ENDPOINT="$PRIMARY_S3_ENDPOINT" S3_ACCESS_KEY="$S3_ROOT_ACCESS" S3_SECRET_KEY="$S3_ROOT_SECRET")
DRENV=(DR_S3_ENDPOINT="$DR_S3_ENDPOINT" DR_S3_ACCESS_KEY="$S3_ROOT_ACCESS" DR_S3_SECRET_KEY="$S3_ROOT_SECRET")
BUCKETENV=(S3_BUCKET_STAGING="$BP-staging" S3_BUCKET_EVIDENCE="$BP-evidence" S3_BUCKET_ARCHIVE="$BP-archive" S3_BUCKET_LONG_TERM="$BP-longterm" S3_BUCKET_DERIVED="$BP-derived" S3_BUCKET_EXPORTS="$BP-exports" S3_BUCKET_REPORTS="$BP-reports")
BACKUPENV=(PGHOST="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$PGADMIN_URL")" PGPORT="$(node -e 'console.log(new URL(process.argv[1]).port||5432)' "$PGADMIN_URL")"
  PGUSER="$(node -e 'console.log(new URL(process.argv[1]).username)' "$PGADMIN_URL")" PGDATABASE="$DB"
  BACKUP_AGE_RECIPIENTS_FILE="$BASE/age.pub" BACKUP_AGE_IDENTITY_FILE="$BASE/age.key"
  BACKUP_SIGNING_KEY_FILE="$BASE/backup-sign.key" BACKUP_SIGNING_PUBKEY_FILE="$BASE/backup-sign.pub"
  BACKUP_S3_ENDPOINT="$DR_S3_ENDPOINT" BACKUP_S3_ACCESS_KEY="$S3_ROOT_ACCESS" BACKUP_S3_SECRET_KEY="$S3_ROOT_SECRET"
  BACKUP_S3_BUCKET="$BP-backups" BACKUP_LOCK_DAYS=1 BACKUP_WORK_DIR="$BASE/backup-work")

cleanup() {
  local rc=$?
  for s in api worker; do stop_svc "$s"; done
  if [ "$KEEP" != 1 ]; then
    log "cleanup: databases and drill objects"
    for d in $(psql "$PGADMIN_URL" -qtAX -c "SELECT datname FROM pg_database WHERE datname LIKE '${DB}%' OR datname LIKE 'ksp_verify_%_$$'"); do
      psql "$PGADMIN_URL" -qtAX -c "DROP DATABASE IF EXISTS \"$d\" WITH (FORCE)" >/dev/null 2>&1 || true
    done
    for b in staging evidence archive longterm derived exports reports; do
      env BACKUP_S3_ENDPOINT="$PRIMARY_S3_ENDPOINT" BACKUP_S3_ACCESS_KEY="$S3_ROOT_ACCESS" BACKUP_S3_SECRET_KEY="$S3_ROOT_SECRET" \
        node "$ROOT/scripts/backup/s3.ts" rm-prefix "$BP-$b" "" --bypass >/dev/null 2>&1 || true
      env BACKUP_S3_ENDPOINT="$PRIMARY_S3_ENDPOINT" BACKUP_S3_ACCESS_KEY="$S3_ROOT_ACCESS" BACKUP_S3_SECRET_KEY="$S3_ROOT_SECRET" \
        node "$ROOT/scripts/backup/s3.ts" rb "$BP-$b" >/dev/null 2>&1 || true
    done
  fi
  stop_svc dr-s3
  if [ "$KEEP" != 1 ]; then rm -rf "$BASE"; else log "kept $BASE"; fi
  exit "$rc"
}
trap cleanup EXIT

age-keygen -o "$BASE/age.key" 2>/dev/null; age-keygen -y "$BASE/age.key" > "$BASE/age.pub"
openssl genpkey -algorithm ed25519 -out "$BASE/backup-sign.key" 2>/dev/null; openssl pkey -in "$BASE/backup-sign.key" -pubout -out "$BASE/backup-sign.pub"
# The DR object store: a second, independent gateway with its own data directory.
(ROOT_ACCESS_KEY="$S3_ROOT_ACCESS" ROOT_SECRET_KEY="$S3_ROOT_SECRET" setsid versitygw --port "127.0.0.1:$DR_S3_PORT" posix \
   --versioning-dir "$BASE/dr-s3/versions" --sidecar "$BASE/dr-s3/sidecar" "$BASE/dr-s3/buckets" > "$BASE/logs/dr-s3.log" 2>&1 & echo $! > "$BASE/dr-s3.pid")
sleep 1

# ---------------------------------------------------------------- 1 provision
step_start provision
psql "$PGADMIN_URL" -qtAX -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB" >/dev/null
(cd "$ROOT" && KSP_ENV_FILE="$BASE/primary.env" node packages/core/dist/bin/migrate.js > "$BASE/logs/migrate.log" 2>&1)
(cd "$ROOT" && KSP_ENV_FILE="$BASE/primary.env" KSP_SEED_CLI=1 node packages/core/dist/bin/seed.js > "$BASE/logs/seed.log" 2>&1)
(cd "$ROOT" && KSP_ENV_FILE="$BASE/primary.env" node scripts/ops/ensure-buckets.mjs > "$BASE/logs/buckets.log" 2>&1)
step_end "$(tail -1 "$BASE/logs/migrate.log")"

# ---------------------------------------------------------------- 2 start (production layouts)
step_start "build-image-layouts"
bash "$ROOT/scripts/ci/simulate-image.sh" api "$BASE/img-api" >/dev/null
bash "$ROOT/scripts/ci/simulate-image.sh" worker "$BASE/img-worker" >/dev/null
step_end "api + worker, npm ci --omit=dev"
step_start start-services
start_svc api "$BASE/img-api" "$BASE/primary.env" node apps/api/dist/server.js
start_svc worker "$BASE/img-worker" "$BASE/primary.env" node apps/worker/dist/main.js
wait_ready
step_end "NODE_ENV=production, /health/ready 200"

# ---------------------------------------------------------------- 3 ingest
step_start ingest
for i in $(seq 1 "$FILES"); do
  ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=25:duration=$SECONDS_PER" \
    -f lavfi -i "sine=frequency=$((300 + i * 100)):duration=$SECONDS_PER" -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -c:a aac -shortest "$BASE/media/drill-$i.mp4"
done
(cd "$ROOT" && KSP_PASSWORD='Ksp@Dev-Passw0rd!' node tools/station-client/dist/cli.js --server "http://127.0.0.1:$API_PORT" \
   --username io.meera --station ps_cubbonpark --state "$BASE/upload-state.json" --label "DR drill" "$BASE/media" > "$BASE/logs/upload.log" 2>&1) \
   || { cat "$BASE/logs/upload.log" >&2; exit 1; }
q() { psql "$ADMIN_BASE/$DB" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
for _ in $(seq 1 240); do
  [ "$(q "SELECT count(*) FROM evidence WHERE status='REGISTERED' AND media_status='READY'")" = "$FILES" ] && break; sleep 0.5
done
READY=$(q "SELECT count(*) FROM evidence WHERE status='REGISTERED' AND media_status='READY'")
[ "$READY" = "$FILES" ] || { log "only $READY/$FILES evidence items READY"; tail -30 "$BASE/logs/worker.log" >&2; exit 1; }
ORIG_BYTES=$(q "SELECT coalesce(sum(size_bytes),0) FROM evidence")
DERIVED_BYTES=$(q "SELECT coalesce(sum(size_bytes),0) FROM evidence_derivatives")
AUDIT_BEFORE=$(q "SELECT max(seq) FROM audit_events")
DB_BYTES=$(q "SELECT pg_database_size(current_database())")
step_end "$FILES items REGISTERED+READY, originals ${ORIG_BYTES} B, derivatives ${DERIVED_BYTES} B, audit head $AUDIT_BEFORE"

# ---------------------------------------------------------------- 4 backup
step_start backup
env "${BACKUPENV[@]}" bash "$ROOT/scripts/backup/pg-backup.sh" > "$BASE/logs/backup.log" 2>&1 || { cat "$BASE/logs/backup.log" >&2; exit 1; }
step_end "$(grep '^backup ' "$BASE/logs/backup.log" | cut -c1-160)"

# ---------------------------------------------------------------- 5 replicate
step_start replicate-objects
env "${S3ENV_PRIMARY[@]}" "${DRENV[@]}" "${BUCKETENV[@]}" DATABASE_URL="$APP_URL_BASE/$DB" \
  node "$ROOT/scripts/backup/s3-replicate.ts" --lock-days 1 > "$BASE/logs/replicate.json" 2>&1 || { cat "$BASE/logs/replicate.json" >&2; exit 1; }
step_end "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(`${j.copied} objects, ${j.bytes} B, ${j.verified} originals hash-verified vs DB, ${j.failed} failed`)' "$BASE/logs/replicate.json")"

# ---------------------------------------------------------------- 6 verify
step_start verify-backup
env "${BACKUPENV[@]}" VERIFY_ADMIN_URL="$PGADMIN_URL" bash "$ROOT/scripts/backup/verify-backup.sh" latest > "$BASE/logs/verify.log" 2>&1 || { cat "$BASE/logs/verify.log" >&2; exit 1; }
step_end "$(grep -o 'audit chain OK[^)]*)' "$BASE/logs/verify.log")"

# ---------------------------------------------------------------- DISASTER
step_start disaster
stop_svc api; stop_svc worker
psql "$PGADMIN_URL" -qtAX -c "DROP DATABASE \"$DB\" WITH (FORCE)" >/dev/null
step_end "services stopped, database $DB dropped, primary object store abandoned"

# ---------------------------------------------------------------- 7 restore
RESTORE_T0=$(now_ms)
step_start restore-database
env "${BACKUPENV[@]}" bash "$ROOT/scripts/backup/restore.sh" --admin-url "$PGADMIN_URL" --database "$DB" --source latest > "$BASE/logs/restore.log" 2>&1 \
  || { cat "$BASE/logs/restore.log" >&2; exit 1; }
step_end "$(grep -c 'OK' "$BASE/logs/restore.log") checks OK"
step_start "migrate+storage-check"
(cd "$ROOT" && KSP_ENV_FILE="$BASE/dr.env" node packages/core/dist/bin/migrate.js > "$BASE/logs/migrate2.log" 2>&1)
(cd "$ROOT" && KSP_ENV_FILE="$BASE/dr.env" node scripts/ops/ensure-buckets.mjs > "$BASE/logs/buckets2.log" 2>&1) || { cat "$BASE/logs/buckets2.log" >&2; exit 1; }
step_end "$(tail -1 "$BASE/logs/migrate2.log"); DR buckets verified (missing staging bucket created)"

# ---------------------------------------------------------------- 8 repoint
step_start repoint
env "${DRENV[@]}" "${BUCKETENV[@]}" DATABASE_URL="$APP_URL_BASE/$DB" node "$ROOT/scripts/backup/s3-replicate.ts" --repoint > "$BASE/logs/repoint.json" 2>&1 \
  || { cat "$BASE/logs/repoint.json" >&2; exit 1; }
step_end "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(`${j.verified} originals re-hashed in DR store, ${j.repointed} pointers moved`)' "$BASE/logs/repoint.json")"

# ---------------------------------------------------------------- 9 recover
step_start start-services-dr
# The primary services must really be gone, or wait_ready could be answered by a stale process.
for port in "$API_PORT" "$METRICS_PORT" "$((METRICS_PORT+1))"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "port $port still in use after the disaster step" >&2; exit 1; fi
done
start_svc api "$BASE/img-api" "$BASE/dr.env" node apps/api/dist/server.js
start_svc worker "$BASE/img-worker" "$BASE/dr.env" node apps/worker/dist/main.js
wait_ready
step_end "/health/ready 200 against DR store"
RTO_MS=$(( $(now_ms) - RESTORE_T0 ))
printf '%s\t%s\t%s\n' "RESTORE→SERVICE READY (RTO, excl. detection)" "$RTO_MS" "" >> "$REPORT"

# ---------------------------------------------------------------- 10 validate
step_start validate-service
node "$ROOT/tests/dr/api-check.ts" "http://127.0.0.1:$API_PORT" io.meera 'Ksp@Dev-Passw0rd!' "$FILES" --fixity > "$BASE/logs/api-check.json" 2>&1 \
  || { cat "$BASE/logs/api-check.json" >&2; tail -30 "$BASE/logs/worker.log" >&2; exit 1; }
step_end "$(cut -c1-200 "$BASE/logs/api-check.json")"
step_start validate-integrity
env "${DRENV[@]}" "${BUCKETENV[@]}" DATABASE_URL="$APP_URL_BASE/$DB" node "$ROOT/scripts/backup/s3-replicate.ts" --verify-only > "$BASE/logs/dr-verify.json" 2>&1 \
  || { cat "$BASE/logs/dr-verify.json" >&2; exit 1; }
AV=$(q "SELECT checked || '|' || coalesce(first_bad_seq::text,'none') || '|' || head_seq FROM audit_verify()")
[ "$(cut -d'|' -f2 <<<"$AV")" = none ] || { log "audit chain broken after recovery: $AV"; exit 1; }
[ "$(q "SELECT count(*) FROM audit_events WHERE action = 'EVIDENCE_STORAGE_REPOINTED'")" = "$FILES" ] || { log "missing repoint custody events"; exit 1; }
step_end "DR copies verified; audit_verify: $(cut -d'|' -f1 <<<"$AV") events, no break (head $(cut -d'|' -f3 <<<"$AV"))"

{
  echo
  echo "DR DRILL PASSED  ($(date -u +%FT%TZ), $FILES files x ${SECONDS_PER}s 640x360)"
  echo "data volume: originals $ORIG_BYTES B, derivatives $DERIVED_BYTES B, database $DB_BYTES B, audit events $AUDIT_BEFORE (pre-disaster)"
  printf '%-44s %10s  %s\n' STEP MS DETAIL
  while IFS=$'\t' read -r n ms d; do printf '%-44s %10s  %s\n' "$n" "$ms" "$d"; done < "$REPORT"
} | tee "${DRILL_REPORT_OUT:-/dev/null}"
