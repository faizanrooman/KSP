# Source this file to put the project-local toolchain on PATH.
# Usage: source scripts/dev/env.sh
KSP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export KSP_ROOT
export PATH="$KSP_ROOT/.local/node/bin:$KSP_ROOT/.local/bin:/usr/lib/postgresql/16/bin:$PATH"
export KSP_DATA="$KSP_ROOT/.local/data"
