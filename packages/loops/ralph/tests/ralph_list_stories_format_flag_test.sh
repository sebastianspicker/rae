#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

run_cli_overrides_env_to_full() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit RALPH_LIST_STORIES_FORMAT=ids ./ralph.sh --list-stories --list-stories-format full > "$tmpdir/list.out" 2> "$tmpdir/list.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "list-format-cli-overrides-env-full" "expected success, got rc=$rc" "$tmpdir/list.err" "$tmpdir"
  fi
  if ! grep -q $'\t' "$tmpdir/list.out"; then
    fail_case "list-format-cli-overrides-env-full" "expected tab-separated full output" "$tmpdir/list.out" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [list-format-cli-overrides-env-full]\n'
}

run_cli_overrides_env_to_ids() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit RALPH_LIST_STORIES_FORMAT=full ./ralph.sh --list-stories --list-stories-format ids > "$tmpdir/list.out" 2> "$tmpdir/list.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "list-format-cli-overrides-env-ids" "expected success, got rc=$rc" "$tmpdir/list.err" "$tmpdir"
  fi
  if grep -q $'\t' "$tmpdir/list.out"; then
    fail_case "list-format-cli-overrides-env-ids" "expected ids-only output without tabs" "$tmpdir/list.out" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [list-format-cli-overrides-env-ids]\n'
}

run_cli_overrides_env_to_full
run_cli_overrides_env_to_ids
printf 'All list-stories format flag tests passed.\n'
