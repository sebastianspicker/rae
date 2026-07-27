#!/usr/bin/env bash
# Removes an installed agent environment profile while preserving the profile recovery contract.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091 # Root is computed from this entry point.
source "$ROOT_DIR/installers/runtime.sh"
rae_require_runtime
TARGET_DIR="${1:-}"

if [[ -z "$TARGET_DIR" || $# -ne 1 ]]; then
  printf 'Usage: %s <target-dir>\n' "$0" >&2
  exit 2
fi

exec "$PYTHON_BIN" "$ROOT_DIR/installers/profile_transaction.py" uninstall "$TARGET_DIR"
