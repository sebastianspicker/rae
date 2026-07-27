#!/usr/bin/env bash
# Installs an agent environment profile transactionally so supported targets can be changed safely.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091 # Root is computed from this entry point.
source "$ROOT_DIR/installers/runtime.sh"
rae_require_runtime
FORCE=false

usage() {
  printf 'Usage: %s [--force] <target-dir>\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --force)
    FORCE=true
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  -*)
    printf 'unsupported option: %s\n' "$1" >&2
    usage
    exit 2
    ;;
  *)
    break
    ;;
  esac
done

TARGET_DIR="${1:-}"
if [[ -z "$TARGET_DIR" || $# -ne 1 ]]; then
  usage
  exit 2
fi

args=(install --profile-root "$ROOT_DIR")
[[ "$FORCE" == true ]] && args+=(--force)
args+=("$TARGET_DIR")
exec "$PYTHON_BIN" "$ROOT_DIR/installers/profile_transaction.py" "${args[@]}"
