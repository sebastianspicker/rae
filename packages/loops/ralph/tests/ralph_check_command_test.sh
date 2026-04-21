#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_check_success_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --check > "$tmpdir/check.out" 2> "$tmpdir/check.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "check-success" "expected success, got rc=$rc" "$tmpdir/check.err" "$tmpdir"
  fi
  if ! grep -q '^Mode:' "$tmpdir/check.out"; then
    fail_case "check-success" "missing status snapshot in check output" "$tmpdir/check.out" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [check-success]\n'
}

run_check_failure_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  jq 'del(.stories[0].id)' "$tmpdir/prd.json" > "$tmpdir/prd.bad.json"
  mv "$tmpdir/prd.bad.json" "$tmpdir/prd.json"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --check > "$tmpdir/check.out" 2> "$tmpdir/check.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "check-failure" "expected non-zero on invalid PRD" "$tmpdir/check.err" "$tmpdir"
  fi
  if ! grep -q 'Invalid prd.json structure or story constraints' "$tmpdir/check.err"; then
    fail_case "check-failure" "missing expected PRD failure message" "$tmpdir/check.err" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [check-failure]\n'
}

run_check_success_case
run_check_failure_case
printf 'All check command tests passed.\n'
