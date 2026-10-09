#!/usr/bin/env bash
# Load demo content into the running demo deployment (run INSIDE the demo container, as root):
#
#   bash deploy/proxmox/load-demo-content.sh [--force] [--password '<demo password if you changed it>']
#
# 1. brings the deployment to the current checkout (install-in-lxc.sh --skip-git: rebuilds changed images, migrates)
# 2. demo seed (idempotent): reference data, demo cameras, and any MISSING demo users — note: demo users you deleted
#    are created again (with the demo password); run this only on a demo system
# 3. scripts/demo/load-demo-content.mjs inside the worker image (Node + FFmpeg + libass already there) against the API on
#    the internal network: 10 body-worn-camera videos, 2 FIRs with cases and case diary, AI analyses, an investigation
#    workspace with bookmarks and a court export waiting for supervisor approval. Skips if already loaded (--force: again).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
C=(docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env)
FQDN=$(grep '^APP_BASE_URL=' deploy/compose/.env | tail -1 | cut -d= -f2- | sed -E 's#^https?://##; s#/.*##')
[ -n "$FQDN" ] || { echo "APP_BASE_URL not found in deploy/compose/.env — is this the demo deployment?" >&2; exit 1; }

mkdir -p /var/lib/ksp-autodeploy
exec 9>/var/lib/ksp-autodeploy/lock
flock 9   # never run concurrently with an automatic deployment

echo "== bringing the deployment to $(git rev-parse --short HEAD)"
bash deploy/proxmox/install-in-lxc.sh --fqdn "$FQDN" --skip-git >/tmp/ksp-demo-install.log 2>&1 \
  || { tail -n 30 /tmp/ksp-demo-install.log; echo "installer failed — full log: /tmp/ksp-demo-install.log" >&2; exit 1; }

echo "== demo seed (reference data, demo cameras, missing demo users)"
"${C[@]}" run --rm -T -e KSP_SEED_CLI=1 migrate node packages/core/dist/bin/seed.js

echo "== demo content"
"${C[@]}" run --rm --no-deps -T \
  -v "$PWD/scripts/demo:/demo:ro" -v "$PWD/apps/ai-worker/test/fixtures/images:/images:ro" \
  -e KSP_API=http://api:4000 -e IMAGES_DIR=/images -e WORK=/work/demo-content \
  worker node /demo/load-demo-content.mjs "$@"
echo "open https://$FQDN — e.g. io.meera (Cubbon Park), io.arjun (Indiranagar), sup.kavya (approve the pending court export)"
