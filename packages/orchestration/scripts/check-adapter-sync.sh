#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for adapter sync checks." >&2
  exit 2
fi

python3 "$root_dir/scripts/adapters/generate_adapters.py" --check
