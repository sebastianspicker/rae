#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_status_json_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --json --status > "$tmpdir/status.json" 2> "$tmpdir/status.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "cli-json-status" "expected success, got rc=$rc" "$tmpdir/status.err" "$tmpdir"
  fi
  if ! jq -e '.command == "status" and (.stories.total | type == "number") and (.lock.held | type == "boolean")' "$tmpdir/status.json" >/dev/null; then
    fail_case "cli-json-status" "status output is not valid expected JSON shape" "$tmpdir/status.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [cli-json-status]\n'
}

run_list_json_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --json --list-stories > "$tmpdir/list.json" 2> "$tmpdir/list.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "cli-json-list-stories" "expected success, got rc=$rc" "$tmpdir/list.err" "$tmpdir"
  fi
  if ! jq -e 'type == "array" and (length >= 0) and all(.[]; has("id") and has("priority") and has("mode") and has("title"))' "$tmpdir/list.json" >/dev/null; then
    fail_case "cli-json-list-stories" "list-stories output is not valid expected JSON shape" "$tmpdir/list.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [cli-json-list-stories]\n'
}

run_validate_config_json_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --json --validate-config > "$tmpdir/validate.json" 2> "$tmpdir/validate.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "cli-json-validate-config" "expected success, got rc=$rc" "$tmpdir/validate.err" "$tmpdir"
  fi
  if ! jq -e '.command == "validate-config" and .ok == true and (.checks.prd == "ok") and (.checks.jq == "ok") and (.checks.mktemp == "ok")' "$tmpdir/validate.json" >/dev/null; then
    fail_case "cli-json-validate-config" "validate-config output is not valid expected JSON shape" "$tmpdir/validate.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [cli-json-validate-config]\n'
}

run_status_json_case
run_list_json_case
run_validate_config_json_case
printf 'All CLI JSON output tests passed.\n'
