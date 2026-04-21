#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_case() {
  local case_name="$1"
  local jq_expr="$2"
  local tmpdir rc

  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  jq "$jq_expr" "$tmpdir/prd.json" > "$tmpdir/prd.json.tmp"
  mv "$tmpdir/prd.json.tmp" "$tmpdir/prd.json"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "$case_name" "expected validation failure, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Invalid prd.json structure or story constraints' "$tmpdir/out.log"; then
    fail_case "$case_name" "missing validation failure message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$case_name"
}

run_case "prd-invalid-id-pattern" '.stories[0].id = "BAD/001"'
run_case "prd-extra-root-property" '. + {unexpected: true}'
run_case "prd-extra-story-property" '.stories[0] += {unexpected: true}'

printf 'All PRD validation alignment tests passed.\n'
