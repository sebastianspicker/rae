#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

assert_import_state_does_not_override_story_definition() {
  local tmpdir story_id original_title rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  story_id="$(jq -r '.stories[0].id' "$tmpdir/prd.json")"
  original_title="$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title' "$tmpdir/prd.json")"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  jq --arg id "$story_id" '(.stories[] | select(.id == $id)) |= (.passes = true | .report_path = "audit/AUDIT-001.md" | .completed_at = "2026-04-17T00:00:00Z" | .title = "INJECTED TITLE")' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "import-state-preserves-story-definition" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ "$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title' "$tmpdir/prd.json")" != "$original_title" ]]; then
    fail_case "import-state-preserves-story-definition" "import-state unexpectedly changed story title" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ "$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .passes' "$tmpdir/prd.json")" != "true" ]]; then
    fail_case "import-state-preserves-story-definition" "expected status fields to be imported" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-preserves-story-definition]\n'
}

assert_import_state_uses_run_lock() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )

  mkdir -p "$tmpdir/.runtime/.run.lock"
  touch -t 200001010000 "$tmpdir/.runtime/.run.lock"

  set +e
  (
    cd "$tmpdir"
    RALPH_STALE_LOCK_NO_PID_SECONDS=0 ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "import-state-lock-protected" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ -d "$tmpdir/.runtime/.run.lock" ]]; then
    fail_case "import-state-lock-protected" "run lock directory should be released after import-state" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-lock-protected]\n'
}

assert_import_state_rejects_invalid_field_types() {
  local tmpdir rc story_id original_passes
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  story_id="$(jq -r '.stories[0].id' "$tmpdir/prd.json")"
  original_passes="$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .passes' "$tmpdir/prd.json")"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  jq --arg id "$story_id" '(.stories[] | select(.id == $id)) |= (.passes = "yes" | .unexpected = true)' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "import-state-invalid-types" "expected failure for invalid import payload" "$tmpdir/out.log" "$tmpdir"
  fi

  if ! grep -q 'Invalid import-state payload' "$tmpdir/out.log"; then
    fail_case "import-state-invalid-types" "expected invalid payload error" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ "$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .passes' "$tmpdir/prd.json")" != "$original_passes" ]]; then
    fail_case "import-state-invalid-types" "prd.json should remain unchanged after rejected import" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-invalid-types]\n'
}

assert_import_state_can_restore_false_booleans() {
  local tmpdir story_id rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  story_id="$(jq -r '.stories[0].id' "$tmpdir/prd.json")"
  jq --arg id "$story_id" '(.stories[] | select(.id == $id)) |= (.passes = true | .report_path = "audit/report.md" | .completed_at = "2026-04-17T00:00:00Z")' "$tmpdir/prd.json" >"$tmpdir/prd.updated.json"
  mv "$tmpdir/prd.updated.json" "$tmpdir/prd.json"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  jq --arg id "$story_id" '(.stories[] | select(.id == $id)) |= (.passes = false)' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "import-state-restores-false-booleans" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ "$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .passes' "$tmpdir/prd.json")" != "false" ]]; then
    fail_case "import-state-restores-false-booleans" "passes should restore to false" "$tmpdir/out.log" "$tmpdir"
  fi
  if jq -e --arg id "$story_id" '.stories[] | select(.id == $id) | has("report_path")' "$tmpdir/prd.json" >/dev/null; then
    fail_case "import-state-restores-false-booleans" "report_path should be cleared when passes=false" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-restores-false-booleans]\n'
}

assert_import_state_rejects_cross_project_payload() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  jq '.project = "other-project" | .project_fingerprint_sha256 = "deadbeef"' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "import-state-cross-project" "expected cross-project import to fail" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'fingerprints do not match' "$tmpdir/out.log"; then
    fail_case "import-state-cross-project" "expected fingerprint mismatch error" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-cross-project]\n'
}

assert_import_state_rejects_stale_story_definitions() {
  local tmpdir story_id rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )

  story_id="$(jq -r '.stories[0].id' "$tmpdir/prd.json")"
  jq --arg id "$story_id" '(.stories[] | select(.id == $id) | .title) = "Updated title"' "$tmpdir/prd.json" >"$tmpdir/prd.updated.json"
  mv "$tmpdir/prd.updated.json" "$tmpdir/prd.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "import-state-stale-definition" "expected stale-definition import to fail" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'fingerprints do not match' "$tmpdir/out.log"; then
    fail_case "import-state-stale-definition" "expected fingerprint mismatch error" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-stale-definition]\n'
}

assert_import_state_rejects_duplicate_ids() {
  local tmpdir story_id rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  story_id="$(jq -r '.stories[0].id' "$tmpdir/state.json")"
  jq --arg id "$story_id" '.stories += [{"id": $id, "passes": true}]' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "import-state-duplicate-ids" "expected duplicate-id import to fail" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Invalid import-state payload' "$tmpdir/out.log"; then
    fail_case "import-state-duplicate-ids" "expected invalid payload error" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-duplicate-ids]\n'
}

assert_import_state_revalidates_semantics_before_persisting() {
  local tmpdir story_id rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    ./ralph.sh --export-state >"$tmpdir/state.json"
  )
  story_id="$(jq -r '.stories[0].id' "$tmpdir/state.json")"
  jq --arg id "$story_id" '(.stories[] | select(.id == $id)) |= (.passes = true | del(.report_path, .completed_at))' "$tmpdir/state.json" >"$tmpdir/state.updated.json"
  mv "$tmpdir/state.updated.json" "$tmpdir/state.json"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --import-state "$tmpdir/state.json"
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "import-state-semantic-validation" "expected semantic validation failure" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Import produced invalid prd.json structure' "$tmpdir/out.log"; then
    fail_case "import-state-semantic-validation" "expected semantic validation error" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [import-state-semantic-validation]\n'
}

assert_import_state_does_not_override_story_definition
assert_import_state_uses_run_lock
assert_import_state_rejects_invalid_field_types
assert_import_state_can_restore_false_booleans
assert_import_state_rejects_cross_project_payload
assert_import_state_rejects_stale_story_definitions
assert_import_state_rejects_duplicate_ids
assert_import_state_revalidates_semantics_before_persisting

printf 'All import-state guardrail tests passed.\n'
