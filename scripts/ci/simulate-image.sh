#!/usr/bin/env bash
# Reproduce the file layout of a runtime image WITHOUT Docker and start its entrypoint, so the production
# `node dist/...` entrypoints are verified with production-only dependencies (npm ci --omit=dev -w <app>).
#
#   scripts/ci/simulate-image.sh <api|worker|ai-worker|migrate> <out-dir> [--run]
#
# Mirrors deploy/docker/Dockerfile stages prod-deps-<app> + runtime-base + <app>. Requires `npm run build` first.
# With --run the entrypoint is started with the environment of the current shell (plus NODE_ENV=production
# overrides you pass) and cwd=<out-dir>, i.e. no .env file and no source tree — exactly like the container.
set -euo pipefail
APP="${1:?usage: simulate-image.sh <api|worker|ai-worker|migrate> <out-dir> [--run]}"
OUT="${2:?out dir}"
RUN="${3:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$APP" in
  api|migrate) WS=@ksp/api; DIR=apps/api; CMD=(node apps/api/dist/server.js) ;;
  worker) WS=@ksp/worker; DIR=apps/worker; CMD=(node apps/worker/dist/main.js) ;;
  ai-worker) WS=@ksp/ai-worker; DIR=apps/ai-worker; CMD=(node apps/ai-worker/dist/main.js) ;;
  *) echo "unknown app $APP" >&2; exit 2 ;;
esac
[ "$APP" = migrate ] && CMD=(node packages/core/dist/bin/migrate.js)

for d in packages/shared/dist packages/core/dist "$DIR/dist"; do
  [ -d "$ROOT/$d" ] || { echo "missing $d — run npm run build first" >&2; exit 1; }
done

rm -rf "$OUT"; mkdir -p "$OUT"
# --- prod-manifests / prod-deps-<app>
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.npmrc" "$OUT/"
for p in packages/shared packages/core apps/api apps/worker apps/ai-worker apps/web tools/station-client; do
  mkdir -p "$OUT/$p"; cp "$ROOT/$p/package.json" "$OUT/$p/"
done
(cd "$OUT" && npm ci --omit=dev --no-audit --no-fund --loglevel=error -w @ksp/shared -w @ksp/core -w "$WS" >/dev/null)
# --- runtime-base + app stage: only package.json + dist of the packages in use, plus db/migrations
for p in apps/web tools/station-client; do rm -rf "${OUT:?}/$p"; done
for p in packages/shared packages/core "$DIR"; do cp -r "$ROOT/$p/dist" "$OUT/$p/dist"; done
cp -r "$ROOT/packages/core/assets" "$OUT/packages/core/assets"   # PDF fonts
mkdir -p "$OUT/db"; cp -r "$ROOT/db/migrations" "$OUT/db/migrations"
mkdir -p "$OUT/scripts/ops"
case "$APP" in
  ai-worker) cp "$ROOT/scripts/ops/fetch-models.mjs" "$OUT/scripts/ops/" ;;
  api|migrate) cp "$ROOT/scripts/ops/ensure-buckets.mjs" "$OUT/scripts/ops/" ;;
esac
rm -f "$OUT/package-lock.json" "$OUT/.npmrc"
echo "image layout for $APP in $OUT ($(du -sh "$OUT" | cut -f1), node_modules $(du -sh "$OUT/node_modules" | cut -f1))"
if [ -n "$(find "$OUT/node_modules" -maxdepth 2 -name 'typescript' -o -maxdepth 2 -name 'vitest' -o -maxdepth 2 -name 'tsx' | head -1)" ]; then
  echo "dev dependencies leaked into the production layout" >&2; exit 1
fi
if [ "$RUN" = --run ]; then
  cd "$OUT"
  exec "${CMD[@]}"
fi
