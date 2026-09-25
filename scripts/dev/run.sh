#!/usr/bin/env bash
# Start/stop app processes for THIS checkout with pid files (never pattern-kill: other worktrees run the same commands).
#   scripts/dev/run.sh start|stop|restart api|worker|ai|web|all
set -euo pipefail
source "$(dirname "$0")/env.sh"
ACTION="${1:?start|stop|restart}"; WHAT="${2:-all}"
RUN="$KSP_ROOT/.local/run"; mkdir -p "$RUN" "$KSP_ROOT/.local/logs"
declare -A DIR=([api]=apps/api [worker]=apps/worker [ai]=apps/ai-worker [web]=apps/web)
declare -A CMD=([api]="npx tsx --conditions=ksp-src src/server.ts" [worker]="npx tsx --conditions=ksp-src src/main.ts" [ai]="npx tsx --conditions=ksp-src src/main.ts" [web]="npx vite --host 127.0.0.1")
start() { local n=$1; [ -d "$KSP_ROOT/${DIR[$n]}" ] || return 0
  if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n: running"; return; fi
  (cd "$KSP_ROOT/${DIR[$n]}" && setsid nohup ${CMD[$n]} > "$KSP_ROOT/.local/logs/$n.log" 2>&1 & echo $! > "$RUN/$n.pid"); echo "$n: started (log .local/logs/$n.log)"; }
stop() { local n=$1; [ -f "$RUN/$n.pid" ] || return 0; local p; p=$(cat "$RUN/$n.pid"); kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true; rm -f "$RUN/$n.pid"; echo "$n: stopped"; }
names=("$WHAT"); [ "$WHAT" = all ] && names=(api worker ai web)
for n in "${names[@]}"; do case "$ACTION" in start) start "$n";; stop) stop "$n";; restart) stop "$n"; sleep 1; start "$n";; esac; done
