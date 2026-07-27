#!/usr/bin/env bash
# Checks generated adapter definitions against their sources to prevent stale orchestration behavior.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$root_dir/scripts/lib/runtime.sh"
orchestration_require_runtime

"$PYTHON_BIN" "$root_dir/scripts/adapters/generate_adapters.py" --check
