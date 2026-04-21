#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  jq '
    .properties.custom_root = {"type":"string"}
    | ."$defs".story.properties.custom_story = {"type":"string"}
    | ."$defs".story_step.properties.custom_step = {"type":"string"}
  ' "$tmpdir/prd.schema.json" > "$tmpdir/prd.schema.json.tmp"
  mv "$tmpdir/prd.schema.json.tmp" "$tmpdir/prd.schema.json"

  jq '
    .custom_root = "ok"
    | .stories[0].custom_story = "ok"
    | .stories[0].steps[0].custom_step = "ok"
  ' "$tmpdir/prd.json" > "$tmpdir/prd.json.tmp"
  mv "$tmpdir/prd.json.tmp" "$tmpdir/prd.json"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "schema-runtime-properties-contract" "expected success when schema allows extra properties" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [schema-runtime-properties-contract]\n'
}

run_case
printf 'All schema/runtime properties contract tests passed.\n'
