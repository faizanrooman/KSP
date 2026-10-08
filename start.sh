#!/usr/bin/env bash
# One-command start of the KSP Video Evidence Management System on a development/demo host.
#
#   ./start.sh            start everything (first run: secrets, deps, migrations, seed data, AI models)
#   ./start.sh stop       stop the application processes (PostgreSQL / S3 keep running; add --services to stop them too)
#   ./start.sh restart    restart the application processes
#   ./start.sh status     show what is running
#   ./start.sh logs       tail the application logs
#
# Linux and macOS natively; Windows through WSL2 (run start.bat). Production deployments use deploy/ (docs/DEPLOYMENT.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"
ACTION="${1:-start}"; shift || true

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# shellcheck source=scripts/dev/env.sh
source scripts/dev/env.sh

envval() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-; }
api_port() { envval API_PORT; }
web_url() { envval APP_BASE_URL; }

check_tools() {
  local missing=()
  for t in node npm psql pg_ctl initdb createdb versitygw ffmpeg ffprobe openssl curl; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  echo "Missing tools: ${missing[*]}" >&2
  case "$(uname -s)" in
    Darwin) cat >&2 <<'EOF'
Install with Homebrew:
  brew install node@22 postgresql@16 ffmpeg openssl
  # versitygw (S3 gateway): https://github.com/versity/versitygw/releases  -> copy the binary to .local/bin/versitygw
EOF
      ;;
    *) cat >&2 <<'EOF'
Install on Debian/Ubuntu (incl. WSL2):
  sudo apt-get install -y postgresql-16 ffmpeg openssl curl        # PostgreSQL client+server binaries
  # Node 22: https://nodejs.org (or nvm) — or unpack a Node 22 tarball into .local/node/
  # versitygw (S3 gateway): https://github.com/versity/versitygw/releases -> .local/bin/versitygw (chmod +x)
EOF
      ;;
  esac
  die "Install the tools above (they only need to be on PATH or in .local/bin) and run ./start.sh again."
}

wait_api() {
  local port="$1"
  for _ in $(seq 1 90); do curl -fsS -m 2 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

do_start() {
  bold "KSP VMS — starting (root: $ROOT)"
  check_tools
  scripts/dev/services.sh start                                   # PostgreSQL :5433 + S3 gateway :7480 (local data in .local/data)
  if [ ! -f .env ]; then bold "First run: generating development secrets and .env"; scripts/dev/init-env.sh; fi
  if [ ! -d node_modules/@ksp ]; then bold "Installing dependencies (npm ci)"; npm ci --no-audit --no-fund; fi
  [ -d packages/shared/dist ] && [ -d packages/core/dist ] || { bold "Building shared packages"; npm run -s build -w @ksp/shared && npm run -s build -w @ksp/core; }
  bold "Applying database migrations"; npm run -s db:migrate
  local users
  users=$(psql "$(envval DATABASE_MIGRATION_URL)" -qtAX -c "SELECT count(*) FROM users" 2>/dev/null || echo 0)
  if [ "${users:-0}" = 0 ]; then bold "First run: loading demo organisation, users and sample data"; npm run -s db:seed; fi
  if ! ls .local/models/*.onnx >/dev/null 2>&1; then
    bold "Downloading and registering the pinned AI models (one-time, ~300 MB)"
    npm run -s fetch-models -w @ksp/ai-worker || echo "AI models could not be downloaded now — the app runs without AI analysis; re-run ./start.sh when online." >&2
  fi
  # A production-bundle preview (tests/e2e/scripts/stack.sh) may still hold the web port.
  if [ -f .local/run/web-preview.pid ]; then kill -TERM -- -"$(cat .local/run/web-preview.pid)" 2>/dev/null || true; rm -f .local/run/web-preview.pid; fi
  scripts/dev/run.sh start all
  local port; port="$(api_port)"
  bold "Waiting for the API on :$port"
  wait_api "$port" || { tail -40 .local/logs/api.log >&2; die "API did not become ready — see .local/logs/api.log"; }
  cat <<EOF

  Web UI : $(web_url)
  API    : http://127.0.0.1:$port   (OpenAPI: /docs, health: /health/ready)
  Logs   : .local/logs/{api,worker,ai,web}.log      Stop: ./start.sh stop

  Demo sign-ins (password for all: Ksp@Dev-Passw0rd!) — full list in docs/CONTRACTS.md §2
    admin        System administrator (MFA enrolment on first sign-in)
    io.meera     Investigating officer, Cubbon Park PS
    sup.kavya    Supervisor
    fo.ravi      Field officer          op.cubbon  Station upload operator
    fa.naveen    Forensic analyst       ec.latha   Evidence custodian      aud.suresh  Compliance auditor

EOF
  case "$(uname -s)" in Darwin) open "$(web_url)" >/dev/null 2>&1 || true;; esac
}

case "$ACTION" in
  start) do_start ;;
  stop) scripts/dev/run.sh stop all
        if [ -f .local/run/web-preview.pid ]; then kill -TERM -- -"$(cat .local/run/web-preview.pid)" 2>/dev/null || true; rm -f .local/run/web-preview.pid; fi
        [ "${1:-}" = "--services" ] && scripts/dev/services.sh stop; true ;;
  restart) scripts/dev/run.sh restart all; wait_api "$(api_port)" && echo "ready: $(web_url)" ;;
  status) scripts/dev/services.sh status 2>/dev/null || true
          for n in api worker ai web; do if [ -f ".local/run/$n.pid" ] && kill -0 "$(cat ".local/run/$n.pid")" 2>/dev/null; then echo "$n: running (pid $(cat ".local/run/$n.pid"))"; else echo "$n: stopped"; fi; done
          curl -fsS -m 2 "http://127.0.0.1:$(api_port)/health/ready" 2>/dev/null && echo || echo "api: not ready" ;;
  logs) tail -n 50 -F .local/logs/api.log .local/logs/worker.log .local/logs/ai.log .local/logs/web.log ;;
  *) die "usage: ./start.sh [start|stop [--services]|restart|status|logs]" ;;
esac
