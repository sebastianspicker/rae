#!/usr/bin/env bash
# Fails on tracked editor residue so repository artifacts remain portable and reviewable.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$root_dir/scripts/lib/runtime.sh"
orchestration_require_runtime

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required for hygiene checks." >&2
  exit 2
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for hygiene checks." >&2
  exit 2
fi

tracked_matches="$(
  cd "$root_dir"
  git ls-files | rg -n '(^|/)(\.DS_Store|Thumbs\.db|.*\.swp|.*\.swo|.*\.tmp|.*\.bak|.*\.orig)$' || true
)"

if [[ -n "$tracked_matches" ]]; then
  echo "FAIL: tracked local-junk files detected:" >&2
  echo "$tracked_matches" >&2
  exit 1
fi

echo "OK: repository hygiene checks passed"
