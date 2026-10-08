#!/usr/bin/env bash
# Start/stop app processes for THIS checkout with pid files (never pattern-kill: other worktrees run the same commands).
#   scripts/dev/run.sh start|stop|restart api|worker|ai|web|all
set -euo pipefail
source "$(dirname "$0")/env.sh"
ACTION="${1:?start|stop|restart}"; WHAT="${2:-all}"
RUN="$KSP_ROOT/.local/run"; mkdir -p "$RUN" "$KSP_ROOT/.local/logs"
SETSID="$(command -v setsid || true)"
declare -A DIR=([api]=apps/api [worker]=apps/worker [ai]=apps/ai-worker [web]=apps/web)
declare -A CMD=([api]="npx tsx --conditions=ksp-src src/server.ts" [worker]="npx tsx --conditions=ksp-src src/main.ts" [ai]="npx tsx --conditions=ksp-src src/main.ts" [web]="npx vite --host 127.0.0.1")
start() { local n=$1; [ -d "$KSP_ROOT/${DIR[$n]}" ] || return 0
  if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n: running"; return; fi
  # The child writes its OWN pid after setsid, so the pid file holds the session/process-group leader.
  # setsid is Linux (util-linux); macOS has none — fall back to a plain background process (stop() then kills the pid itself).
  # exec + redirecting the whole subshell: no intermediate shell stays alive holding the caller's stdout/stderr
  # (otherwise `scripts/dev/run.sh start | tail` never returns while a service runs).
  (cd "$KSP_ROOT/${DIR[$n]}" && exec ${SETSID:-} bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$RUN/$n.pid" ${CMD[$n]}) > "$KSP_ROOT/.local/logs/$n.log" 2>&1 < /dev/null &
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$RUN/$n.pid" ] && break; sleep 0.2; done
  echo "$n: started pid $(cat "$RUN/$n.pid" 2>/dev/null) (log .local/logs/$n.log)"; }
stop() { local n=$1; [ -f "$RUN/$n.pid" ] || return 0; local p; p=$(cat "$RUN/$n.pid")
  kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
  for _ in $(seq 1 25); do kill -0 -- -"$p" 2>/dev/null || break; sleep 0.2; done
  kill -0 -- -"$p" 2>/dev/null && kill -KILL -- -"$p" 2>/dev/null || true
  rm -f "$RUN/$n.pid"; echo "$n: stopped"; }
names=("$WHAT"); [ "$WHAT" = all ] && names=(api worker ai web)
for n in "${names[@]}"; do case "$ACTION" in start) start "$n";; stop) stop "$n";; restart) stop "$n"; sleep 1; start "$n";; esac; done
