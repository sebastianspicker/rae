#!/usr/bin/env bash
# Regression coverage for Ralph's runtime state confinement contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp ln grep

assert_runtime_state_dir_must_stay_in_repo() {
  local tmpdir external_state rc
  tmpdir="$(mktemp -d)"
  external_state="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  ln -s "$external_state" "$tmpdir/.runtime"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --status
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    rm -rf "$external_state"
    fail_case "runtime-state-confinement" "expected failure for external .runtime symlink" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Runtime state directory resolves outside repository' "$tmpdir/out.log"; then
    rm -rf "$external_state"
    fail_case "runtime-state-confinement" "missing confinement error message" "$tmpdir/out.log" "$tmpdir"
  fi

  rm -rf "$external_state"
  cleanup_dir "$tmpdir"
  printf 'PASS [runtime-state-confinement]\n'
}

assert_runtime_state_dir_must_stay_in_repo
printf 'All runtime state confinement tests passed.\n'
