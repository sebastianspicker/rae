#!/usr/bin/env bash
# Regression coverage for Ralph's version flag contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

# --version prints version string and exits 0
run_version_flag_case() {
  local output
  output="$("$RUNNER" --version 2>&1)" || fail_case "version-flag" "exit code non-zero" "" ""
  if [[ "$output" != ralph\ * ]]; then
    fail_case "version-flag" "expected output starting with 'ralph ', got: $output" "" ""
  fi
  # Must contain a semver-like version number
  if ! printf '%s' "$output" | grep -qE '^ralph [0-9]+\.[0-9]+\.[0-9]+'; then
    fail_case "version-flag" "expected semver version, got: $output" "" ""
  fi
  printf 'PASS [version-flag]\n'
}

run_version_flag_case
printf 'All version flag tests passed.\n'
