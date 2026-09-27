#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok/bad/skip only print, so "A && ok || bad" is intended
# Static validation of every deployment artefact WITHOUT Docker or a cluster (used locally and in CI):
#   hadolint (Dockerfile) · shellcheck (all scripts) · kustomize build + kubeconform (all overlays, CRDs from the
#   datree CRD catalog) · actionlint (GitHub workflows) · docker compose config (with throwaway secrets) ·
#   JSON/YAML well-formedness of monitoring config.
#   scripts/ci/validate-deploy.sh [--strict] [--no-docker]     tools looked up on PATH, then .local/bin
# Exit 1 if any validator fails. A validator that is not installed is reported as SKIP — except in strict mode
# (--strict, or CI=true), where a missing validator FAILS: install them with scripts/ci/install-tools.sh.
# --no-docker explicitly opts out of the docker compose check (hosts without Docker); it is reported, never silent.
set -uo pipefail
STRICT=0; NO_DOCKER=0
[ "${CI:-}" = true ] && STRICT=1
for a in "$@"; do
  case "$a" in
    --strict) STRICT=1 ;;
    --no-docker) NO_DOCKER=1 ;;
    *) echo "usage: $0 [--strict] [--no-docker]" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
export PATH="$PATH:$ROOT/.local/bin"
fail=0; T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
step() { printf '\n== %s\n' "$1"; }
ok() { echo "OK   $1"; }
bad() { echo "FAIL $1"; fail=1; }
skip() { if [ "$STRICT" = 1 ]; then bad "$1 (tool not installed; strict mode — run scripts/ci/install-tools.sh)"; else echo "SKIP $1 (tool not installed)"; fi; }
[ "$STRICT" = 1 ] && echo "strict mode: missing validators fail"


step hadolint
if command -v hadolint >/dev/null; then
  hadolint -c deploy/docker/.hadolint.yaml deploy/docker/Dockerfile && ok Dockerfile || bad Dockerfile
else skip hadolint; fi

step shellcheck
if command -v shellcheck >/dev/null; then
  mapfile -t sh < <(find scripts/backup scripts/ops scripts/ci deploy tests/dr -name '*.sh' -not -path '*/node_modules/*' 2>/dev/null | sort)
  shellcheck -x "${sh[@]}" && ok "${#sh[@]} scripts" || bad shellcheck
else skip shellcheck; fi

step "kustomize + kubeconform"
if command -v kustomize >/dev/null && command -v kubeconform >/dev/null; then
  for o in staging production staging/jobs production/jobs; do
    out="$T/k-${o//\//-}.yaml"
    if ! kustomize build "deploy/k8s/overlays/$o" > "$out"; then bad "kustomize $o"; continue; fi
    kubeconform -strict -summary -kubernetes-version 1.30.0 \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      "$out" && ok "overlay $o ($(grep -c '^kind:' "$out") objects)" || bad "kubeconform $o"
  done
else skip "kustomize/kubeconform"; fi

step actionlint
if command -v actionlint >/dev/null; then
  actionlint -shellcheck "$(command -v shellcheck || true)" && ok ".github/workflows" || bad actionlint
else skip actionlint; fi

step "docker compose config"
if [ "$NO_DOCKER" = 1 ]; then echo "SKIP docker compose (--no-docker requested: compose file NOT validated on this host)"
elif docker compose version >/dev/null 2>&1; then
  mkdir -p "$T/secrets"
  bash scripts/ops/generate-secrets.sh --out "$T/secrets" --format compose --env-name ci >/dev/null
  { cat deploy/compose/.env.example; grep -v '^#' "$T/secrets/secrets.env"
    echo "BACKUP_S3_ENDPOINT=https://backup.example"; } > "$T/.env"
  # compose resolves secrets files relative to the compose file: point a temporary copy at the throwaway set.
  sed "s#file: ./secrets/#file: $T/secrets/#; s#\.\./\.\./db/#$ROOT/db/#; s#\.\./monitoring/#$ROOT/deploy/monitoring/#; s#\./postgres/#$ROOT/deploy/compose/postgres/#" \
    deploy/compose/docker-compose.yml > "$T/docker-compose.yml"
  if docker compose -f "$T/docker-compose.yml" --env-file "$T/.env" --profile ai --profile ops config -q; then
    ok "compose ($(docker compose -f "$T/docker-compose.yml" --env-file "$T/.env" --profile ai --profile ops config --services | wc -l) services)"
  else bad "compose config"; fi
else skip "docker compose"; fi
[ "$NO_DOCKER" = 1 ] && [ "${CI:-}" = true ] && bad "docker compose (--no-docker is not allowed in CI)"

step "monitoring config"
for f in deploy/monitoring/grafana/dashboards/*.json; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$f" && ok "$f" || bad "$f"; done
if command -v promtool >/dev/null; then
  promtool check rules deploy/monitoring/prometheus/rules/*.yml && ok "prometheus rules" || bad "prometheus rules"
else skip promtool; fi

echo
[ "$fail" = 0 ] && echo "VALIDATION PASSED" || echo "VALIDATION FAILED"
exit "$fail"
