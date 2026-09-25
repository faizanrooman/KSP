#!/usr/bin/env bash
# CI bootstrap: roles, throwaway keys and .env/.env.test for the test suites, against the job's PostgreSQL and
# S3 containers. Never used outside CI (keys are generated fresh per run and discarded).
#   scripts/ci/ci-env.sh   (env: PGHOST PGPORT PGUSER PGPASSWORD, S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY, FFMPEG_DIR)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="$ROOT/.local/secrets"; mkdir -p "$S" "$ROOT/.local/models" "$ROOT/.local/work"; chmod 700 "$S"
: "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
export PGHOST PGPORT PGUSER
openssl genpkey -algorithm ed25519 -out "$S/jwt.key" 2>/dev/null
openssl pkey -in "$S/jwt.key" -pubout -out "$S/jwt.pub"
openssl req -x509 -newkey rsa:3072 -nodes -keyout "$S/signing.key" -out "$S/signing.crt" -days 2 -subj "/CN=KSP CI signing (NOT FOR COURT USE)" 2>/dev/null
APP_PW=$(openssl rand -hex 16); AI_PW=$(openssl rand -hex 16)
psql -d postgres -qX -v ON_ERROR_STOP=1 -v app_password="'$APP_PW'" -v ai_password="'$AI_PW'" -f "$ROOT/db/bootstrap/roles.sql"
for db in ksp ksp_test; do psql -d postgres -qtAX -c "CREATE DATABASE $db" >/dev/null 2>&1 || true; done
MIG="postgres://$PGUSER:${PGPASSWORD:-}@$PGHOST:$PGPORT"
FF="${FFMPEG_DIR:-/usr/local/bin}"
write() { # file db env port bucketprefix lockdays
cat > "$1" <<ENV
NODE_ENV=$3
LOG_LEVEL=warn
API_PORT=$4
DATABASE_URL=postgres://ksp_app:$APP_PW@$PGHOST:$PGPORT/$2
DATABASE_MIGRATION_URL=$MIG/$2
DATABASE_AI_URL=postgres://ksp_ai:$AI_PW@$PGHOST:$PGPORT/$2
S3_ENDPOINT=${S3_ENDPOINT:-http://127.0.0.1:7070}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-kspciaccess}
S3_SECRET_KEY=${S3_SECRET_KEY:-kspcisecret-not-secret}
S3_FORCE_PATH_STYLE=true
S3_BUCKET_STAGING=$5-staging
S3_BUCKET_EVIDENCE=$5-evidence
S3_BUCKET_ARCHIVE=$5-archive
S3_BUCKET_LONG_TERM=$5-longterm
S3_BUCKET_DERIVED=$5-derived
S3_BUCKET_EXPORTS=$5-exports
S3_BUCKET_REPORTS=$5-reports
OBJECT_LOCK_MODE=GOVERNANCE
OBJECT_LOCK_DAYS=$6
JWT_PRIVATE_KEY=file:$S/jwt.key
JWT_PUBLIC_KEY=file:$S/jwt.pub
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
MEDIA_TOKEN_SECRET=$(openssl rand -hex 32)
SIGNING_PRIVATE_KEY=file:$S/signing.key
SIGNING_CERTIFICATE=file:$S/signing.crt
FFMPEG_PATH=$FF/ffmpeg
FFPROBE_PATH=$FF/ffprobe
WORK_DIR=$ROOT/.local/work/$2
AI_MODELS_DIR=$ROOT/.local/models
ENV
}
write "$ROOT/.env" ksp development 4000 kspci 1
write "$ROOT/.env.test" ksp_test test 4100 kspcit 1
echo "CI env ready (.env, .env.test)"
