#!/usr/bin/env bash
# Start/stop the stack the E2E suite runs against, for THIS checkout (pid files; never pattern-kill).
#   tests/e2e/scripts/stack.sh start|stop|status [--dev-web]
# api/worker/ai-worker via scripts/dev/run.sh; the API runs with NODE_ENV=test semantics against the checkout's .env
# (only effect: login/global rate limits relaxed so ~60 logins per run are not throttled). The web UI is the
# production bundle (`vite build`) served by `vite preview` with the same /api proxy — use --dev-web for the Vite
# dev server instead (HMR; slower first load).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ACTION="${1:?start|stop|status}"; MODE="${2:-}"
RUN="$ROOT/.local/run"; LOGS="$ROOT/.local/logs"; mkdir -p "$RUN" "$LOGS"
source "$ROOT/scripts/dev/env.sh"
port() { grep -E "^$1=" "$ROOT/.env" | cut -d= -f2-; }
API_PORT="$(port API_PORT)"; WEB_URL="$(port APP_BASE_URL)"

web_start() {
  if [ "$MODE" = "--dev-web" ]; then "$ROOT/scripts/dev/run.sh" start web; return; fi
  if [ -f "$RUN/web-preview.pid" ] && kill -0 "$(cat "$RUN/web-preview.pid")" 2>/dev/null; then echo "web-preview: running"; return; fi
  # Up to 3 attempts: the shared dev host crashes build processes intermittently (KNOWN-ISSUES ENV-1).
  local built=false
  for _ in 1 2 3; do
    if (cd "$ROOT/apps/web" && npx vite build --logLevel warn >"$LOGS/web-build.log" 2>&1); then built=true; break; fi
  done
  if [ "$built" != true ]; then
    echo "web build failed (see .local/logs/web-build.log) — falling back to the Vite dev server"; tail -3 "$LOGS/web-build.log"
    "$ROOT/scripts/dev/run.sh" start web; return
  fi
  (cd "$ROOT/apps/web" && setsid bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUN/web-preview.pid" npx vite preview >"$LOGS/web-preview.log" 2>&1 </dev/null &)
  echo "web-preview: started (log .local/logs/web-preview.log)"
}
web_stop() {
  "$ROOT/scripts/dev/run.sh" stop web
  [ -f "$RUN/web-preview.pid" ] || return 0
  local p; p="$(cat "$RUN/web-preview.pid")"; kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
  rm -f "$RUN/web-preview.pid"; echo "web-preview: stopped"
}
wait_ready() {
  for _ in $(seq 1 60); do
    curl -fsS -m 2 "http://127.0.0.1:$API_PORT/health/ready" >/dev/null 2>&1 && curl -fsS -m 2 "$WEB_URL/login" >/dev/null 2>&1 && { echo "stack ready: api :$API_PORT, web $WEB_URL"; return; }
    sleep 1
  done
  echo "stack not ready (see .local/logs)"; exit 1
}

case "$ACTION" in
  start)
    NODE_ENV=test KSP_ENV_FILE="$ROOT/.env" "$ROOT/scripts/dev/run.sh" start api
    "$ROOT/scripts/dev/run.sh" start worker
    "$ROOT/scripts/dev/run.sh" start ai
    web_start; wait_ready ;;
  stop) web_stop; for s in ai worker api; do "$ROOT/scripts/dev/run.sh" stop "$s"; done ;;
  status) curl -fsS -m 2 "http://127.0.0.1:$API_PORT/health/ready" && echo && curl -fsS -m 2 -o /dev/null -w "web %{http_code}\n" "$WEB_URL/login" ;;
  *) echo "usage: $0 start|stop|status [--dev-web]"; exit 1 ;;
esac
