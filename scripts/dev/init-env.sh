#!/usr/bin/env bash
# Generate development secrets and .env/.env.test (idempotent: never overwrites existing keys).
# Production secrets must come from the secrets manager (see docs/SECURITY-ARCHITECTURE.md) — never from this script.
set -euo pipefail
source "$(dirname "$0")/env.sh"
S="$KSP_ROOT/.local/secrets"; mkdir -p "$S"; chmod 700 "$S"
[ -f "$S/jwt.key" ] || { openssl genpkey -algorithm ed25519 -out "$S/jwt.key"; openssl pkey -in "$S/jwt.key" -pubout -out "$S/jwt.pub"; }
if [ ! -f "$S/signing.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$S/signing.key"
  openssl req -new -x509 -key "$S/signing.key" -out "$S/signing.crt" -days 825 \
    -subj "/C=IN/ST=Karnataka/O=KSP VMS Development/CN=KSP VMS Dev Evidence Signing (NOT FOR COURT USE)"
fi
[ -f "$S/data.key" ] || openssl rand -base64 32 > "$S/data.key"
[ -f "$S/media.key" ] || openssl rand -hex 32 > "$S/media.key"
[ -f "$S/app.pw" ] || openssl rand -hex 16 > "$S/app.pw"
[ -f "$S/ai.pw" ] || openssl rand -hex 16 > "$S/ai.pw"
chmod 600 "$S"/*

PGPORT="${PGPORT:-5433}"
psql -h 127.0.0.1 -p "$PGPORT" -U ksp -d postgres -q -v ON_ERROR_STOP=1 \
  -v app_password="'$(cat "$S/app.pw")'" -v ai_password="'$(cat "$S/ai.pw")'" -f "$KSP_ROOT/db/bootstrap/roles.sql"

write_env() { # $1 file, $2 database
  cat > "$1" <<ENV
NODE_ENV=$3
LOG_LEVEL=${4:-info}
APP_BASE_URL=http://localhost:5173
API_PORT=${5:-4000}
CORS_ORIGINS=http://localhost:5173
COOKIE_SECURE=false
DATABASE_URL=postgres://ksp_app:$(cat "$S/app.pw")@127.0.0.1:$PGPORT/$2
DATABASE_MIGRATION_URL=postgres://ksp@127.0.0.1:$PGPORT/$2
DATABASE_AI_URL=postgres://ksp_ai:$(cat "$S/ai.pw")@127.0.0.1:$PGPORT/$2
S3_ENDPOINT=http://127.0.0.1:${S3PORT:-7480}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-kspdevaccess}
S3_SECRET_KEY=${S3_SECRET_KEY:-kspdevsecret-change-me}
S3_FORCE_PATH_STYLE=true
S3_BUCKET_STAGING=$6-staging
S3_BUCKET_EVIDENCE=$6-evidence
S3_BUCKET_ARCHIVE=$6-evidence-archive
S3_BUCKET_LONG_TERM=$6-evidence-longterm
S3_BUCKET_DERIVED=$6-derived
S3_BUCKET_EXPORTS=$6-exports
S3_BUCKET_REPORTS=$6-reports
OBJECT_LOCK_MODE=GOVERNANCE
OBJECT_LOCK_DAYS=3650
JWT_PRIVATE_KEY=file:$S/jwt.key
JWT_PUBLIC_KEY=file:$S/jwt.pub
DATA_ENCRYPTION_KEY=$(cat "$S/data.key")
MEDIA_TOKEN_SECRET=$(cat "$S/media.key")
SIGNING_PRIVATE_KEY=file:$S/signing.key
SIGNING_CERTIFICATE=file:$S/signing.crt
SIGNING_KEY_ID=ksp-dev-signing-key
FFMPEG_PATH=$KSP_ROOT/.local/bin/ffmpeg
FFPROBE_PATH=$KSP_ROOT/.local/bin/ffprobe
WORK_DIR=$KSP_ROOT/.local/work/$2
AI_MODELS_DIR=$KSP_ROOT/.local/models
ENV
}
[ -f "$KSP_ROOT/.env" ] || write_env "$KSP_ROOT/.env" ksp development info 4000 ksp
write_env "$KSP_ROOT/.env.test" ksp_test test warn 4100 ksptest
echo "env ready: .env, .env.test"
