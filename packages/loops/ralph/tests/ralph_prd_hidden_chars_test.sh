#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_fixture "$tmpdir/repo"

  jq '.stories[0].title = "bad\u202Etitle"' "$tmpdir/repo/prd.json" > "$tmpdir/repo/prd.tmp.json"
  mv "$tmpdir/repo/prd.tmp.json" "$tmpdir/repo/prd.json"

  set +e
  (
    cd "$tmpdir/repo"
    ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "prd-hidden-chars" "expected failure for hidden/bidi chars in PRD" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'disallowed hidden/control/bidi characters' "$tmpdir/out.log"; then
    fail_case "prd-hidden-chars" "expected hidden char validation failure message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [prd-hidden-chars]\n'
}

run_case
printf 'All PRD hidden-char validation tests passed.\n'
