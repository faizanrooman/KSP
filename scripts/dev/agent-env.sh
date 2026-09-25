#!/usr/bin/env bash
# Give a worktree / workstream its OWN databases, buckets and ports so parallel work never collides.
#   scripts/dev/agent-env.sh <name> [port-offset]
# Creates DBs ksp_<name> and ksp_test_<name>, writes .env and .env.test in this checkout, migrates + seeds dev DB.
set -euo pipefail
NAME="${1:?usage: agent-env.sh <name> [port-offset]}"; OFF="${2:-10}"
[[ "$NAME" =~ ^[a-z0-9_]{2,20}$ ]] || { echo "name must be [a-z0-9_]"; exit 1; }
source "$(dirname "$0")/env.sh"
S="$KSP_MAIN/.local/secrets"; PGPORT=5433
[ -f "$S/app.pw" ] || { echo "run scripts/dev/init-env.sh in the main checkout first"; exit 1; }
for db in "ksp_$NAME" "ksp_test_$NAME"; do
  psql -h 127.0.0.1 -p $PGPORT -U ksp -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || createdb -h 127.0.0.1 -p $PGPORT -U ksp "$db"
done
BP="k${NAME//_/}"
mk() { # file db env port bucketprefix
cat > "$1" <<ENV
NODE_ENV=$3
LOG_LEVEL=warn
APP_BASE_URL=http://localhost:$((5173+OFF))
API_PORT=$4
METRICS_PORT=$((9464+OFF*2))
CORS_ORIGINS=http://localhost:$((5173+OFF))
COOKIE_SECURE=false
DATABASE_URL=postgres://ksp_app:$(cat "$S/app.pw")@127.0.0.1:$PGPORT/$2
DATABASE_MIGRATION_URL=postgres://ksp@127.0.0.1:$PGPORT/$2
DATABASE_AI_URL=postgres://ksp_ai:$(cat "$S/ai.pw")@127.0.0.1:$PGPORT/$2
S3_ENDPOINT=http://127.0.0.1:7480
S3_ACCESS_KEY=kspdevaccess
S3_SECRET_KEY=kspdevsecret-change-me
S3_FORCE_PATH_STYLE=true
S3_BUCKET_STAGING=$5-staging
S3_BUCKET_EVIDENCE=$5-evidence
S3_BUCKET_ARCHIVE=$5-archive
S3_BUCKET_LONG_TERM=$5-longterm
S3_BUCKET_DERIVED=$5-derived
S3_BUCKET_EXPORTS=$5-exports
S3_BUCKET_REPORTS=$5-reports
OBJECT_LOCK_MODE=GOVERNANCE
OBJECT_LOCK_DAYS=$([ "$3" = test ] && echo 1 || echo 3650)
JWT_PRIVATE_KEY=file:$S/jwt.key
JWT_PUBLIC_KEY=file:$S/jwt.pub
DATA_ENCRYPTION_KEY=$(cat "$S/data.key")
MEDIA_TOKEN_SECRET=$(cat "$S/media.key")
SIGNING_PRIVATE_KEY=file:$S/signing.key
SIGNING_CERTIFICATE=file:$S/signing.crt
SIGNING_KEY_ID=ksp-dev-signing-key
FFMPEG_PATH=$KSP_MAIN/.local/bin/ffmpeg
FFPROBE_PATH=$KSP_MAIN/.local/bin/ffprobe
WORK_DIR=$KSP_MAIN/.local/work/$2
AI_MODELS_DIR=$KSP_MAIN/.local/models
ENV
}
mk "$KSP_ROOT/.env" "ksp_$NAME" development $((4000+OFF)) "$BP"
mk "$KSP_ROOT/.env.test" "ksp_test_$NAME" test $((4100+OFF)) "${BP}t"
echo "wrote .env (db ksp_$NAME, api :$((4000+OFF))) and .env.test (db ksp_test_$NAME)"
