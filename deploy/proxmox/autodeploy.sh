#!/usr/bin/env bash
# Pull-based continuous deployment for the demo container (run by the ksp-autodeploy systemd timer; see
# enable-autodeploy.sh). Each run:
#   1. git fetch; nothing to do when origin/<branch> is the deployed commit
#   2. CI gate: the GitHub Actions workflow "$KSP_REQUIRED_WORKFLOW" (default: ci) must have COMPLETED SUCCESSFULLY for
#      exactly that commit — still running → try again next run; failed/cancelled → skipped (logged once)
#   3. check out exactly that commit and run install-in-lxc.sh --skip-git (rebuild changed images, migrate, restart)
#   4. health check (web tier + API container healthy); the deployed commit is recorded only on success
# Pull-based on purpose: nothing on the server is reachable from GitHub (no inbound SSH, no self-hosted runner that
# fork pull requests could execute code on). Logs: journalctl -u ksp-autodeploy; last run: /var/lib/ksp-autodeploy/.
set -euo pipefail

main() {
  # shellcheck disable=SC1091
  [ -f /etc/ksp-autodeploy.env ] && . /etc/ksp-autodeploy.env
  local DIR="${KSP_DIR:-/opt/ksp}" BRANCH="${KSP_BRANCH:-main}" REPO="${KSP_GITHUB_REPO:-rooman-itsd/KSP}"
  local WORKFLOW="${KSP_REQUIRED_WORKFLOW:-ci}" FQDN="${KSP_FQDN:?KSP_FQDN not set in /etc/ksp-autodeploy.env}"
  local STATE=/var/lib/ksp-autodeploy
  mkdir -p "$STATE"
  exec 9>"$STATE/lock"
  flock -n 9 || { echo "another deployment is running"; return 0; }

  cd "$DIR"
  git fetch -q origin "$BRANCH"
  local target current
  target=$(git rev-parse "origin/$BRANCH")
  current=$(cat "$STATE/deployed" 2>/dev/null || git rev-parse HEAD)
  [ "$target" = "$current" ] && return 0
  [ "$(cat "$STATE/skipped" 2>/dev/null)" = "$target" ] && return 0

  # --- CI gate (public repository: unauthenticated API, called only when there is a new commit) -------------------
  local auth=() runs result
  [ -n "${KSP_GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $KSP_GITHUB_TOKEN")
  runs=$(curl -fsSL -m 30 "${auth[@]}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/actions/runs?head_sha=$target&event=push&per_page=50") \
    || { echo "GitHub API not reachable — will retry"; return 0; }
  result=$(jq -r --arg wf "$WORKFLOW" '[.workflow_runs[] | select(.name == $wf)] | sort_by(.run_attempt) | last | if . == null then "none" else "\(.status)/\(.conclusion)" end' <<<"$runs")
  case "$result" in
    completed/success) ;;
    none|queued/*|in_progress/*|waiting/*|requested/*|pending/*)
      echo "new commit ${target:0:7}: CI '$WORKFLOW' not finished ($result) — waiting"; return 0 ;;
    *)
      echo "new commit ${target:0:7}: CI '$WORKFLOW' did not pass ($result) — NOT deploying; ${current:0:7} stays live"
      echo "$target" > "$STATE/skipped"; return 0 ;;
  esac

  # --- deploy exactly the verified commit ---------------------------------------------------------------------------
  echo "deploying ${current:0:7} -> ${target:0:7} ($(git log -1 --format=%s "$target" | cut -c1-80))"
  local started log=$STATE/last-deploy.log
  started=$(date -u +%FT%TZ)
  git checkout -q --detach "$target"
  # extra installer flags from /etc/ksp-autodeploy.env, e.g. KSP_INSTALL_ARGS="--ai-legal-gates off"
  local extra=(); read -r -a extra <<< "${KSP_INSTALL_ARGS:-}"
  if ! bash deploy/proxmox/install-in-lxc.sh --fqdn "$FQDN" --skip-git "${extra[@]}" > "$log" 2>&1; then
    echo "DEPLOY FAILED for ${target:0:7} (installer) — see $log; last lines:"; tail -n 30 "$log"
    echo "$target" > "$STATE/skipped"; return 1
  fi

  local C=(docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env) healthy=0
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && [ "$("${C[@]}" ps api --format '{{.Health}}' | sort -u)" = healthy ]; then healthy=1; break; fi
    sleep 5
  done
  if [ "$healthy" != 1 ]; then
    echo "DEPLOY UNHEALTHY for ${target:0:7}: web/API not healthy after 5 min — check: ${C[*]} ps; ${C[*]} logs --tail 50 api"
    echo "$target" > "$STATE/skipped"; return 1
  fi
  echo "$target" > "$STATE/deployed"
  printf '%s\t%s\t%s\n' "$started" "$(date -u +%FT%TZ)" "$target" >> "$STATE/history.tsv"
  echo "deployed ${target:0:7} — healthy"
}

# The whole script is parsed before it runs (main), so checking out a new version of this file mid-run is harmless.
main "$@"
exit $?
