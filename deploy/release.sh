#!/usr/bin/env bash
set -euo pipefail
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
operations=${SERVER_OPERATIONS_HOME:-$HOME/agent-config/skills/server-operations}
[[ -f "$operations/scripts/release.py" ]] || { echo "Missing server-operations checkout: $operations" >&2; exit 1; }
exec python3 "$operations/scripts/release.py" --project "$project" "$@"
