#!/usr/bin/env bash
# Run INSIDE a Debian 12 / Ubuntu 22.04+ container or VM (root). Installs Docker, fetches the repository, generates
# secrets, writes deploy/compose/.env for a single-host DEMO deployment and starts the stack (compose).
#
#   bash install-in-lxc.sh --fqdn ksp.lan [--ghcr-token <PAT read:packages>] [--no-ai] [--repo URL] [--ref main]
#
# Demo tier: KSP_ENVIRONMENT=demo + KSP_PREFLIGHT=warn (the production preflight logs its findings instead of refusing:
# self-signed signing key, GOVERNANCE object lock, bundled S3 gateway, demo users). For production follow docs/GO-LIVE-CHECKLIST.md.
set -euo pipefail
FQDN=""; TOKEN=""; AI=1; REPO="https://github.com/faizanrooman/KSP.git"; REF="main"; DIR=/opt/ksp
while [ $# -gt 0 ]; do
  case "$1" in
    --fqdn) FQDN="$2"; shift 2 ;; --ghcr-token) TOKEN="$2"; shift 2 ;; --no-ai) AI=0; shift ;;
    --repo) REPO="$2"; shift 2 ;; --ref) REF="$2"; shift 2 ;; --dir) DIR="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$FQDN" ] || { echo "--fqdn is required" >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg openssl jq >/dev/null
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null || { echo "Docker daemon not running (LXC needs features: nesting=1,keyctl=1)" >&2; exit 1; }

echo "== repository"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin && git -C "$DIR" checkout -q "$REF" && git -C "$DIR" pull -q --ff-only; else git clone -q --branch "$REF" "$REPO" "$DIR"; fi
cd "$DIR"
COMPOSE=(docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env)

echo "== secrets + .env"
if [ ! -f deploy/compose/.env ]; then
  scripts/ops/generate-secrets.sh --out deploy/compose/secrets --format all --env-name demo --signing-cn "KSP VMS Demo Signing (NOT FOR COURT USE)" >/dev/null
  # files consumed as Docker secrets (compose `secrets:`), values appended to .env
  grep -vE '^(APP_BASE_URL|CORS_ORIGINS|KSP_IMAGE_REGISTRY|KSP_VERSION|WEB_BIND|BACKUP_S3_ENDPOINT|LOG_LEVEL)=' deploy/compose/.env.example > deploy/compose/.env
  cat deploy/compose/secrets/secrets.env >> deploy/compose/.env
  cat >> deploy/compose/.env <<ENV

# --- demo deployment (deploy/proxmox/install-in-lxc.sh) ---
KSP_IMAGE_REGISTRY=ghcr.io/faizanrooman/ksp
KSP_VERSION=staging
APP_BASE_URL=https://$FQDN
CORS_ORIGINS=https://$FQDN
WEB_BIND=0.0.0.0
LOG_LEVEL=info
KSP_ENVIRONMENT=demo
KSP_PREFLIGHT=warn
KSP_ALLOW_NONEVIDENTIARY_SIGNING=true
DATABASE_TLS_WAIVED=true
OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE=true
BACKUP_S3_ENDPOINT=http://s3:7070
ENV
  chmod 600 deploy/compose/.env
fi

echo "== images"
if [ -n "$TOKEN" ]; then
  echo "$TOKEN" | docker login ghcr.io -u faizanrooman --password-stdin >/dev/null
  "${COMPOSE[@]}" pull -q
else
  echo "no --ghcr-token: building images from source (10–20 min on first run)"
  COMPOSE+=(-f deploy/compose/docker-compose.build.yml)
  "${COMPOSE[@]}" build -q
fi

echo "== database + storage + application"
"${COMPOSE[@]}" up -d postgres s3
"${COMPOSE[@]}" run --rm migrate
# demo organisation, users and sample evidence (the production seed is `seed.js --production`)
"${COMPOSE[@]}" run --rm -e KSP_SEED_CLI=1 migrate node packages/core/dist/bin/seed.js
"${COMPOSE[@]}" up -d api worker web
if [ "$AI" = 1 ]; then
  "${COMPOSE[@]}" --profile ai up -d models   # one-shot download + SHA-256 verification of the pinned models
  "${COMPOSE[@]}" --profile ai up -d ai-worker
fi

# ready = web tier answers and the API container's own HEALTHCHECK (/health/live) reports healthy
for _ in $(seq 1 90); do
  curl -fsS -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && [ "$("${COMPOSE[@]}" ps api --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 2
done
echo
"${COMPOSE[@]}" ps
echo
echo "web tier: http://$(hostname -I | awk '{print $1}'):8080  (put the TLS reverse proxy for https://$FQDN in front of it)"
echo "update later: cd $DIR && git pull && ${COMPOSE[*]} pull && ${COMPOSE[*]} run --rm migrate && ${COMPOSE[*]} up -d"
