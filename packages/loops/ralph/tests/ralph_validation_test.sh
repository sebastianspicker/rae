#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_case() {
  local name="$1"
  local mutate_jq="$2"
  local expect_success="$3"

  local tmpdir out rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  if [[ -n "$mutate_jq" ]]; then
    jq "$mutate_jq" "$tmpdir/prd.json" > "$tmpdir/prd.tmp.json"
    mv "$tmpdir/prd.tmp.json" "$tmpdir/prd.json"
  fi

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh 0
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  out="$(cat "$tmpdir/out.log")"

  if [[ "$expect_success" == "true" ]]; then
    if [[ "$rc" -ne 0 ]]; then
      fail_case "$name" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
    fi
  else
    if [[ "$rc" -eq 0 ]]; then
      fail_case "$name" "expected failure, got success" "$tmpdir/out.log" "$tmpdir"
    fi
    if ! printf '%s' "$out" | grep -q 'Invalid prd.json structure or story constraints'; then
      fail_case "$name" "wrong failure message" "$tmpdir/out.log" "$tmpdir"
    fi
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$name"
}

run_case "valid-prd" "" "true"
run_case "invalid-scope-type" '(.stories[0].scope) = [123]' "false"
run_case "invalid-created-line" '(.stories[0].acceptance_criteria[0]) = "Created   "' "false"
run_case "invalid-acceptance-type" '(.stories[0].acceptance_criteria) = ["Created .claude/ralph-audit/audit/x.md", 7]' "false"
run_case "invalid-steps-shape" '(.stories[0].steps) = [{"title":"x","actions":[],"expected_evidence":["e"],"done_when":["d"]}]' "false"

printf 'All validation tests passed.\n'
