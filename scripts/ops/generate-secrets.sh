#!/usr/bin/env bash
# Generate a complete, production-grade secret set for one KSP VMS environment.
#
#   scripts/ops/generate-secrets.sh --out <dir> [--env-name production] [--format files|compose|k8s|all]
#                                   [--signing-cn "KSP VMS Evidence Signing"] [--force]
#
# Output (<dir> is created 0700, files 0600; never commit it — import into the secrets manager, then shred):
#   files    one file per secret (names = compose secret names / k8s Secret keys)
#   compose  + secrets.env: KEY=value lines for deploy/compose/.env
#   k8s      + k8s-secrets.yaml: plain Kubernetes Secrets to feed to `kubeseal` or to mirror into Vault /
#              AWS Secrets Manager for ExternalSecrets (see docs/SECRETS.md). Plain Secrets must never be applied
#              or committed as-is.
#   signing.csr    certificate signing request for the evidence-signing key (submit to the CA / DSC provider);
#                  a self-signed placeholder certificate is written until the CA-issued one replaces it.
#   backup_age_identity  the backup DECRYPTION key: move it OFFLINE (sealed envelope / HSM-backed vault) and
#                  delete it from <dir>; only backup_age_recipients (public) is deployed.
# Idempotent unless --force: existing files are kept (so re-running never silently rotates a key).
set -euo pipefail
OUT=""; FORMAT=all; ENV_NAME=production; CN="KSP VMS Evidence Signing"; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --env-name) ENV_NAME="$2"; shift 2 ;;
    --signing-cn) CN="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out <dir> is required" >&2; exit 2; }
[[ "$ENV_NAME" =~ ^[a-z0-9-]{2,32}$ ]] || { echo "--env-name must be [a-z0-9-]" >&2; exit 2; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
AGE_KEYGEN="$(command -v age-keygen || true)"
umask 077
mkdir -p "$OUT"; chmod 700 "$OUT"

want() { [ "$FORCE" = 1 ] || [ ! -s "$OUT/$1" ]; }
rand_hex() { openssl rand -hex "$1"; }
# URL-safe password (no characters that need escaping in postgres:// URLs).
rand_pw() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
put() { printf '%s' "$2" > "$OUT/$1"; }

for n in pg_superuser_password ksp_owner_db_password ksp_app_db_password ksp_ai_db_password ksp_backup_db_password grafana_admin_password; do
  want "$n" && put "$n" "$(rand_pw 40)"
done
want s3_root_access_key && put s3_root_access_key "root$(rand_hex 8)"
want s3_root_secret_key && put s3_root_secret_key "$(rand_pw 40)"
want s3_access_key && put s3_access_key "kspapp$(rand_hex 7)"
want s3_secret_key && put s3_secret_key "$(rand_pw 40)"
want s3_ai_access_key && put s3_ai_access_key "kspai$(rand_hex 7)"
want s3_ai_secret_key && put s3_ai_secret_key "$(rand_pw 40)"
want backup_s3_access_key && put backup_s3_access_key "kspbak$(rand_hex 7)"
want backup_s3_secret_key && put backup_s3_secret_key "$(rand_pw 40)"
want data_encryption_key && put data_encryption_key "$(openssl rand -base64 32)"
want media_token_secret && put media_token_secret "$(rand_hex 32)"

if want jwt_private_key; then
  openssl genpkey -algorithm ed25519 -out "$OUT/jwt_private_key" 2>/dev/null
  openssl pkey -in "$OUT/jwt_private_key" -pubout -out "$OUT/jwt_public_key"
fi
if want signing_private_key; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$OUT/signing_private_key" 2>/dev/null
  openssl req -new -key "$OUT/signing_private_key" -out "$OUT/signing.csr" -subj "/C=IN/ST=Karnataka/O=Karnataka State Police/CN=$CN"
  openssl req -new -x509 -key "$OUT/signing_private_key" -out "$OUT/signing_certificate" -days 365 \
    -subj "/C=IN/ST=Karnataka/O=Karnataka State Police/OU=PLACEHOLDER NOT FOR COURT USE/CN=$CN"
  put signing_key_id "ksp-$ENV_NAME-signing-$(date -u +%Y%m%d)"
fi
if want backup_age_identity; then
  if [ -n "$AGE_KEYGEN" ]; then
    "$AGE_KEYGEN" -o "$OUT/backup_age_identity" 2>/dev/null
    "$AGE_KEYGEN" -y "$OUT/backup_age_identity" > "$OUT/backup_age_recipients"
  else
    echo "WARNING: age-keygen not found; backup_age_identity/backup_age_recipients not generated" >&2
  fi
fi
chmod 600 "$OUT"/*

v() { tr -d '\n' < "$OUT/$1"; }
if [ "$FORMAT" = compose ] || [ "$FORMAT" = all ]; then
  cat > "$OUT/secrets.env" <<ENV
# Generated $(date -u +%FT%TZ) for environment '$ENV_NAME' by scripts/ops/generate-secrets.sh — SECRET
KSP_OWNER_DB_PASSWORD=$(v ksp_owner_db_password)
KSP_APP_DB_PASSWORD=$(v ksp_app_db_password)
KSP_AI_DB_PASSWORD=$(v ksp_ai_db_password)
KSP_BACKUP_DB_PASSWORD=$(v ksp_backup_db_password)
S3_ROOT_ACCESS_KEY=$(v s3_root_access_key)
S3_ROOT_SECRET_KEY=$(v s3_root_secret_key)
S3_ACCESS_KEY=$(v s3_access_key)
S3_SECRET_KEY=$(v s3_secret_key)
S3_AI_ACCESS_KEY=$(v s3_ai_access_key)
S3_AI_SECRET_KEY=$(v s3_ai_secret_key)
BACKUP_S3_ACCESS_KEY=$(v backup_s3_access_key)
BACKUP_S3_SECRET_KEY=$(v backup_s3_secret_key)
DATA_ENCRYPTION_KEY=$(v data_encryption_key)
MEDIA_TOKEN_SECRET=$(v media_token_secret)
SIGNING_KEY_ID=$(v signing_key_id)
ENV
fi
if [ "$FORMAT" = k8s ] || [ "$FORMAT" = all ]; then
  b64() { base64 -w0 < "$OUT/$1"; }
  {
    echo "# PLAIN Kubernetes Secrets — seal with kubeseal or load into the external secrets store. NEVER commit/apply as-is."
    echo "apiVersion: v1"; echo "kind: Secret"; echo "metadata: { name: ksp-app, labels: { app.kubernetes.io/part-of: ksp-vms } }"
    echo "type: Opaque"; echo "data:"
    echo "  DATABASE_URL: $(printf 'postgres://ksp_app:%s@ksp-db-rw:5432/ksp?sslmode=require' "$(v ksp_app_db_password)" | base64 -w0)"
    echo "  S3_ACCESS_KEY: $(b64 s3_access_key)"; echo "  S3_SECRET_KEY: $(b64 s3_secret_key)"
    echo "  DATA_ENCRYPTION_KEY: $(b64 data_encryption_key)"; echo "  MEDIA_TOKEN_SECRET: $(b64 media_token_secret)"
    echo "  SIGNING_KEY_ID: $(b64 signing_key_id)"
    echo "  jwt_private_key: $(b64 jwt_private_key)"; echo "  jwt_public_key: $(b64 jwt_public_key)"
    echo "  signing_private_key: $(b64 signing_private_key)"; echo "  signing_certificate: $(b64 signing_certificate)"
    echo "---"
    echo "apiVersion: v1"; echo "kind: Secret"; echo "metadata: { name: ksp-migrate, labels: { app.kubernetes.io/part-of: ksp-vms } }"
    echo "type: Opaque"; echo "data:"
    echo "  DATABASE_MIGRATION_URL: $(printf 'postgres://ksp_owner:%s@ksp-db-rw:5432/ksp?sslmode=require' "$(v ksp_owner_db_password)" | base64 -w0)"
    echo "---"
    echo "apiVersion: v1"; echo "kind: Secret"; echo "metadata: { name: ksp-ai, labels: { app.kubernetes.io/part-of: ksp-vms } }"
    echo "type: Opaque"; echo "data:"
    echo "  DATABASE_AI_URL: $(printf 'postgres://ksp_ai:%s@ksp-db-rw:5432/ksp?sslmode=require' "$(v ksp_ai_db_password)" | base64 -w0)"
    echo "  S3_AI_ACCESS_KEY: $(b64 s3_ai_access_key)"; echo "  S3_AI_SECRET_KEY: $(b64 s3_ai_secret_key)"
    echo "---"
    echo "apiVersion: v1"; echo "kind: Secret"; echo "metadata: { name: ksp-backup, labels: { app.kubernetes.io/part-of: ksp-vms } }"
    echo "type: Opaque"; echo "data:"
    echo "  PGPASSWORD: $(b64 ksp_backup_db_password)"
    echo "  BACKUP_RECORD_URL: $(printf 'postgres://ksp_app:%s@ksp-db-rw:5432/ksp?sslmode=require' "$(v ksp_app_db_password)" | base64 -w0)"
    echo "  BACKUP_S3_ACCESS_KEY: $(b64 backup_s3_access_key)"; echo "  BACKUP_S3_SECRET_KEY: $(b64 backup_s3_secret_key)"
    [ -s "$OUT/backup_age_recipients" ] && echo "  backup_age_recipients: $(b64 backup_age_recipients)"
  } > "$OUT/k8s-secrets.yaml"
fi
echo "secrets for '$ENV_NAME' in $OUT ($(find "$OUT" -maxdepth 1 -type f | wc -l) files)."
[ -s "$OUT/backup_age_identity" ] && echo "ACTION: move $OUT/backup_age_identity OFFLINE now (restore-only key), then delete it here."
[ -s "$OUT/signing.csr" ] && echo "ACTION: submit $OUT/signing.csr to the CA/DSC provider; replace signing_certificate with the issued certificate."
exit 0
