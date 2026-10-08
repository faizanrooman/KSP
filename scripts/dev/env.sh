# Source this file to put the project-local toolchain on PATH.
# Usage: source scripts/dev/env.sh
# Works from the main checkout and from git worktrees (toolchain/secrets live in the MAIN checkout's .local/).
KSP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export KSP_ROOT
_common="$(git -C "$KSP_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$_common" ] && [ -d "$(dirname "$_common")/.local" ]; then KSP_MAIN="$(dirname "$_common")"; else KSP_MAIN="$KSP_ROOT"; fi
export KSP_MAIN
export PATH="$KSP_MAIN/.local/node/bin:$KSP_MAIN/.local/bin:/usr/lib/postgresql/16/bin:$PATH"
# macOS (Homebrew) PostgreSQL 16 keg — not on PATH by default.
for _pg in /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do [ -d "$_pg" ] && export PATH="$_pg:$PATH"; done
export KSP_DATA="$KSP_MAIN/.local/data"
