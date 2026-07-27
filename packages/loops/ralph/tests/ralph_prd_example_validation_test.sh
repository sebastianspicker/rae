#!/usr/bin/env bash
# Regression coverage for Ralph's prd example validation contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"
# shellcheck source=lib/ralph/validate_prd.sh
source "$ROOT_DIR/lib/ralph/validate_prd.sh"

require_cmds jq mktemp

SUPPORTED_MODES_JSON='["audit","linting","fixing"]'
# shellcheck disable=SC2016
CREATED_AC_REGEX='^Created\s+`?[^`\s]+`?(\s+.*)?$'

run_example_validation_case() {
  local tmpdir
  tmpdir="$(mktemp -d)"

  if ! validate_prd_with_jq "$ROOT_DIR/prd.json.example" "$PRD_SCHEMA_FILE" "$PRD_VALIDATE_FILTER_FILE" \
    "$SUPPORTED_MODES_JSON" "$CREATED_AC_REGEX" > "$tmpdir/validate.log" 2>&1; then
    fail_case "prd-example-valid" "prd.json.example failed runtime validation filter" "$tmpdir/validate.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [prd-example-valid]\n'
}

run_example_validation_case
printf 'All PRD example validation tests passed.\n'
