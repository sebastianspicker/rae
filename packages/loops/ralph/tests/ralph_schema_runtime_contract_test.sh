#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  jq '."$defs".defaults.required += ["custom_required_key"]' "$tmpdir/prd.schema.json" > "$tmpdir/prd.schema.json.tmp"
  mv "$tmpdir/prd.schema.json.tmp" "$tmpdir/prd.schema.json"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "schema-runtime-contract" "expected failure when schema required keys diverge from PRD" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Invalid prd.json structure or story constraints' "$tmpdir/out.log"; then
    fail_case "schema-runtime-contract" "missing contract drift error message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [schema-runtime-contract]\n'
}

run_case
printf 'All schema/runtime contract tests passed.\n'
