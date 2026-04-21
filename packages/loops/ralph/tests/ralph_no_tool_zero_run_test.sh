#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

build_path_without_dir() {
  local remove_dir="$1"
  local old_path="$2"
  local item
  local out=""

  IFS=':' read -r -a parts <<< "$old_path"
  for item in "${parts[@]}"; do
    if [[ "$item" == "$remove_dir" ]]; then
      continue
    fi
    if [[ -z "$out" ]]; then
      out="$item"
    else
      out="$out:$item"
    fi
  done
  printf '%s' "$out"
}

run_case() {
  local tmpdir rc tool_path tool_dir clean_path
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  # Remove claude (default tool) from PATH so the tool binary is missing.
  tool_path="$(command -v claude || true)"
  clean_path="$PATH"
  if [[ -n "$tool_path" ]]; then
    tool_dir="$(dirname "$tool_path")"
    clean_path="$(build_path_without_dir "$tool_dir" "$PATH")"
  fi

  set +e
  (
    cd "$tmpdir"
    PATH="$clean_path" MODE=audit ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "no-tool-zero-run" "expected success for N=0 without tool binary, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [no-tool-zero-run]\n'
}

run_case
printf 'All no-tool zero-run tests passed.\n'
