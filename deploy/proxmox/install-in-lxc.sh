#!/usr/bin/env bash
# Run INSIDE a Debian 12 / Ubuntu 22.04+ container or VM (root). Installs Docker, fetches the repository, generates
# secrets, writes deploy/compose/.env for a single-host DEMO deployment and starts the stack (compose).
#
#   bash install-in-lxc.sh --fqdn ksp.lan [--ghcr-token <PAT read:packages>] [--no-ai] [--repo URL] [--ref main]
#                          [--ai-legal-gates enforce|off]
#
# Demo tier: KSP_ENVIRONMENT=demo + KSP_PREFLIGHT=warn (the production preflight logs its findings instead of refusing:
# self-signed signing key, GOVERNANCE object lock, bundled S3 gateway, demo users). For production follow docs/GO-LIVE-CHECKLIST.md.
set -euo pipefail
FQDN=""; TOKEN=""; AI=1; LEGAL_GATES=enforce; REPO="https://github.com/rooman-itsd/KSP.git"; REF="main"; DIR=/opt/ksp; SKIP_GIT=0; GHCR_USER=ksp
while [ $# -gt 0 ]; do
  case "$1" in
    --fqdn) FQDN="$2"; shift 2 ;; --ghcr-token) TOKEN="$2"; shift 2 ;; --no-ai) AI=0; shift ;;
    --repo) REPO="$2"; shift 2 ;; --ref) REF="$2"; shift 2 ;; --dir) DIR="$2"; shift 2 ;;
    --skip-git) SKIP_GIT=1; shift ;;   # deploy the checkout exactly as it is (used by autodeploy.sh, which pins the commit)
    --ai-legal-gates) LEGAL_GATES="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;   # GitHub user that owns the --ghcr-token
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$FQDN" ] || { echo "--fqdn is required" >&2; exit 2; }
case "$LEGAL_GATES" in enforce|off) ;; *) echo "--ai-legal-gates must be enforce or off" >&2; exit 2 ;; esac
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

echo "== packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg openssl jq age locales-all >/dev/null   # age: backup encryption keys
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
if [ "$SKIP_GIT" = 1 ]; then echo "using checkout $(git -C "$DIR" rev-parse --short HEAD) as is"
elif [ -d "$DIR/.git" ]; then git -C "$DIR" remote set-url origin "$REPO"; git -C "$DIR" fetch -q origin && git -C "$DIR" checkout -q "$REF" && git -C "$DIR" pull -q --ff-only; else git clone -q --branch "$REF" "$REPO" "$DIR"; fi
cd "$DIR"
COMPOSE=(docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env)

echo "== secrets + .env"
# idempotent: existing secret files are kept, missing ones (e.g. age keys after installing age) are added
scripts/ops/generate-secrets.sh --out deploy/compose/secrets --format all --env-name demo --signing-cn "KSP VMS Demo Signing (NOT FOR COURT USE)" >/dev/null
if [ ! -f deploy/compose/.env ]; then
  # files consumed as Docker secrets (compose `secrets:`), values appended to .env
  grep -vE '^(APP_BASE_URL|CORS_ORIGINS|KSP_IMAGE_REGISTRY|KSP_VERSION|WEB_BIND|BACKUP_S3_ENDPOINT|LOG_LEVEL)=' deploy/compose/.env.example \
    | grep -vE "^($(cut -d= -f1 deploy/compose/secrets/secrets.env | grep -v '^#' | paste -sd'|'))=" > deploy/compose/.env
  cat deploy/compose/secrets/secrets.env >> deploy/compose/.env
  cat >> deploy/compose/.env <<ENV

# --- demo deployment (deploy/proxmox/install-in-lxc.sh) ---
KSP_IMAGE_REGISTRY=ghcr.io/rooman-itsd/ksp
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
# Compose bind-mounts the secret files as they are on disk; the services run as non-root (api/worker/ai 10001, backup
# 10002, postgres 999), so root-only 0600 files are unreadable in the containers. Inside this dedicated demo CT the
# mounted files are made world-readable; the backup DEcryption identity stays 0600 (move it offline — see generate-secrets).
find deploy/compose/secrets -maxdepth 1 -type f ! -name backup_age_identity ! -name '*.csr' -exec chmod 0644 {} +
chmod 0711 deploy/compose/secrets
# .env may hold a key twice (empty template placeholder first, real value appended later). Compose uses the last
# value; make the file unambiguous by keeping only the last occurrence of every key (comments/blank lines dropped).
awk -F= '/^[A-Z_][A-Z0-9_]*=/ { last[$1]=NR; line[NR]=$0; order[NR]=$1 } END { for (i=1;i<=NR;i++) if (i in line && last[order[i]]==i) print line[i] }' deploy/compose/.env > deploy/compose/.env.tmp && mv deploy/compose/.env.tmp deploy/compose/.env && chmod 600 deploy/compose/.env
# --fqdn is authoritative on every run (moving the demo to a new hostname = re-run with the new --fqdn)
sed -i "s#^APP_BASE_URL=.*#APP_BASE_URL=https://$FQDN#; s#^CORS_ORIGINS=.*#CORS_ORIGINS=https://$FQDN#" deploy/compose/.env
# Demo AI switches: every analytic is installed, and the legal gates are ENFORCED (default) so Settings → Legal approvals
# means what it says — face detection, face recognition and ANPR stay disabled until an administrator records the
# approval. --ai-legal-gates off lets them run without an approval (Settings then shows "Not enforced"). Authoritative on
# every run, like --fqdn: earlier installer versions wrote AI_LEGAL_GATES=off, which this replaces.
grep -q '^AI_TASKS_ENABLED=' deploy/compose/.env || echo 'AI_TASKS_ENABLED=all' >> deploy/compose/.env
if grep -q '^AI_LEGAL_GATES=' deploy/compose/.env; then sed -i "s#^AI_LEGAL_GATES=.*#AI_LEGAL_GATES=$LEGAL_GATES#" deploy/compose/.env
else echo "AI_LEGAL_GATES=$LEGAL_GATES" >> deploy/compose/.env; fi
echo "AI legal gates: $LEGAL_GATES"

echo "== images"
if [ -n "$TOKEN" ]; then
  echo "$TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  "${COMPOSE[@]}" pull -q
  "${COMPOSE[@]}" --profile ops pull -q backup
else
  echo "no --ghcr-token: building images from source (10–20 min on first run)"
  COMPOSE+=(-f deploy/compose/docker-compose.build.yml)
  "${COMPOSE[@]}" build -q
  "${COMPOSE[@]}" --profile ops build -q backup
fi

echo "== database + storage + application"
# s3 (versitygw) is stateless apart from its volume: recreate it so it is always attached to the current networks
# (a `compose down <other service>` removes and recreates the project networks, leaving a running container detached).
"${COMPOSE[@]}" up -d postgres && "${COMPOSE[@]}" up -d --force-recreate --no-deps s3
for _ in $(seq 1 60); do [ "$("${COMPOSE[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] && break; sleep 2; done
# The role passwords are created from the secret files on the FIRST postgres start. If that start happened while the
# files were unreadable (earlier installer versions) the roles exist with wrong passwords; on a database that holds no
# application tables yet, reinitialise the volume instead of failing in migrate.
# Test the way the application connects (over the backend network, password auth): connections from inside the
# postgres container itself are trusted by the image's pg_hba and would always succeed.
PG_IMAGE=$("${COMPOSE[@]}" config --images 2>/dev/null | grep -m1 '^postgres')
PG_DB=$(grep -m1 '^POSTGRES_DB=' deploy/compose/.env | cut -d= -f2-)
owner_ok() { docker run --rm --network ksp-vms_backend -e PGPASSWORD="$(tr -d '\n' < deploy/compose/secrets/ksp_owner_db_password)" "$PG_IMAGE" psql -h postgres -U ksp_owner -d "$PG_DB" -tAc 'select 1' >/dev/null 2>&1; }
if ! owner_ok; then
  tables=$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d "$PG_DB" -tAc "select count(*) from pg_tables where schemaname='public'" 2>/dev/null || echo 0)
  if [ "${tables:-0}" = 0 ]; then
    echo "postgres roles do not match the secret files and the database is empty: reinitialising the data volume"
    "${COMPOSE[@]}" down postgres >/dev/null
    docker volume rm -f ksp-vms_pgdata >/dev/null
    "${COMPOSE[@]}" up -d postgres
    for _ in $(seq 1 60); do [ "$("${COMPOSE[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] && break; sleep 2; done
    owner_ok || { echo "ksp_owner still cannot log in — check deploy/compose/postgres/10-ksp-roles.sh output: ${COMPOSE[*]} logs postgres" >&2; exit 1; }
  else
    echo "ksp_owner cannot log in but the database has tables — not touching it. Fix the role password manually:" >&2
    echo "  ${COMPOSE[*]} exec postgres psql -U postgres -c \"ALTER ROLE ksp_owner PASSWORD '<deploy/compose/secrets/ksp_owner_db_password>'\"" >&2
    exit 1
  fi
fi
# The bundled versitygw only knows its ROOT key pair; the application and AI identities generated by
# generate-secrets.sh must exist in its IAM store (VGW_IAM_DIR). Both get the admin role here — on a real S3 store the
# AI identity is restricted to the derived bucket by policy (deploy/s3/policies/ai.json).
envv() { grep "^$1=" deploy/compose/.env | tail -1 | cut -d= -f2-; }
vgw_admin() { "${COMPOSE[@]}" run --rm --no-deps --entrypoint versitygw s3 admin -a "$(envv S3_ROOT_ACCESS_KEY)" -s "$(envv S3_ROOT_SECRET_KEY)" --er http://s3:7071 "$@"; }
for _ in $(seq 1 30); do vgw_admin list-users >/dev/null 2>&1 && break; sleep 1; done
# The backup identity writes the encrypted database backups (bucket BACKUP_S3_BUCKET, versioned + Object Lock). In this
# demo it lives in the same bundled store; production keeps backups on a separate site (docs/BACKUP-RESTORE-RUNBOOK.md).
for id in "$(envv S3_ACCESS_KEY):$(envv S3_SECRET_KEY)" "$(envv S3_AI_ACCESS_KEY):$(envv S3_AI_SECRET_KEY)" "$(envv BACKUP_S3_ACCESS_KEY):$(envv BACKUP_S3_SECRET_KEY)"; do
  if vgw_admin list-users 2>/dev/null | grep -q "${id%%:*}"; then echo "s3 identity ${id%%:*}: present"
  else vgw_admin create-user -a "${id%%:*}" -s "${id#*:}" -r admin >/dev/null && echo "s3 identity ${id%%:*}: created"; fi
done
"${COMPOSE[@]}" run --rm migrate
# demo organisation, users and sample evidence (the production seed is `seed.js --production`) — FIRST install only:
# re-seeding on later runs would re-create demo users an administrator deliberately deleted, with the public password.
users=$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d "$PG_DB" -tAc "select count(*) from users" 2>/dev/null | tr -d '[:space:]' || true)
if [ "${users:-0}" = 0 ]; then "${COMPOSE[@]}" run --rm -e KSP_SEED_CLI=1 migrate node packages/core/dist/bin/seed.js
else echo "demo data present ($users users): seed skipped"; fi
"${COMPOSE[@]}" up -d api worker web
if [ "$AI" = 1 ]; then
  "${COMPOSE[@]}" --profile ai up -d models   # one-shot download + SHA-256 verification of the pinned models
  "${COMPOSE[@]}" --profile ai up -d ai-worker
fi

echo "== backups"
# Nightly encrypted database backup (scripts/backup/pg-backup.sh in the backup image): each run is recorded in
# backup_runs and shown under System health → Backups. Compose has no scheduler, so a systemd timer runs it.
cat > /etc/systemd/system/ksp-backup.service <<UNIT
[Unit]
Description=KSP VMS nightly encrypted database backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/env ${COMPOSE[*]} --profile ops run --rm backup
TimeoutStartSec=2h
UNIT
cat > /etc/systemd/system/ksp-backup.timer <<UNIT
[Unit]
Description=KSP VMS nightly database backup (01:30 IST)

[Timer]
OnCalendar=*-*-* 20:00:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now ksp-backup.timer >/dev/null
# First run now when no backup has succeeded in the last 26 h (the System health threshold), so the status appears at once.
ok_recent=$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d "$PG_DB" -tAc "select count(*) from backup_runs where status = 'SUCCEEDED' and finished_at > now() - interval '26 hours'" 2>/dev/null | tr -d '[:space:]' || true)
if [ "${ok_recent:-0}" = 0 ]; then systemctl start --no-block ksp-backup.service && echo "backup: first run started (journalctl -u ksp-backup)"
else echo "backup: a successful run in the last 26 h is recorded"; fi
echo "backup schedule: $(systemctl list-timers ksp-backup.timer --no-legend 2>/dev/null | awk '{print $1, $2, $3}')"

# ready = web tier answers and the API container's own HEALTHCHECK (/health/live) reports healthy
for _ in $(seq 1 90); do
  curl -fsS -m 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && [ "$("${COMPOSE[@]}" ps api --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 2
done
echo
"${COMPOSE[@]}" ps
echo
echo "web tier: http://$(hostname -I | awk '{print $1}'):8080  (put the TLS reverse proxy for https://$FQDN in front of it)"
echo "update later: cd $DIR && git pull && bash deploy/proxmox/install-in-lxc.sh --fqdn $FQDN   (idempotent: rebuild/pull, migrate, restart)"
