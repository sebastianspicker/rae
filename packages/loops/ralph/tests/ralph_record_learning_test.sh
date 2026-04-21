#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

prepare_record_script_root() {
  local dir="$1"
  mkdir -p "$dir/scripts/lib" "$dir/lib/ralph"
  cp "$ROOT_DIR/scripts/record_learning.sh" "$dir/scripts/record_learning.sh"
  cp "$ROOT_DIR/scripts/lib/append_safe.sh" "$dir/scripts/lib/append_safe.sh"
  cp "$ROOT_DIR/scripts/lib/parse_opts.sh" "$dir/scripts/lib/parse_opts.sh"
  cp "$ROOT_DIR/lib/ralph/compat.sh" "$dir/lib/ralph/compat.sh"
}

run_create_and_append_case() {
  local tmpdir script_root out_file rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_record_script_root "$script_root"
  out_file="$script_root/state/learnings.md"

  set +e
  "$script_root/scripts/record_learning.sh" --out "$out_file" --story AUDIT-001 --note "Prefer deterministic sorting" --files "lib/ralph/prd.sh,tests/ralph_validation_test.sh" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "record-learning-create" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$out_file" ]]; then
    fail_case "record-learning-create" "expected learnings file to be created" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '^### .* UTC | AUDIT-001$' "$out_file"; then
    fail_case "record-learning-create" "missing first entry header" "$out_file" "$tmpdir"
  fi
  if ! grep -q -- '- Note: Prefer deterministic sorting' "$out_file"; then
    fail_case "record-learning-create" "missing first entry note" "$out_file" "$tmpdir"
  fi

  set +e
  "$script_root/scripts/record_learning.sh" --out "$out_file" --story FIX-002 --note "Guard report path overwrite" >"$tmpdir/out2.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "record-learning-create" "expected second append success, got rc=$rc" "$tmpdir/out2.log" "$tmpdir"
  fi
  if [[ "$(grep -c '^### .* UTC | ' "$out_file")" -ne 2 ]]; then
    fail_case "record-learning-create" "expected two learning entries after append" "$out_file" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [record-learning-create]\n'
}

run_validation_case() {
  local tmpdir script_root rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_record_script_root "$script_root"

  set +e
  "$script_root/scripts/record_learning.sh" --note "Missing story should fail" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "record-learning-validation" "expected failure for missing --story" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'missing required --story' "$tmpdir/out.log"; then
    fail_case "record-learning-validation" "expected missing story error" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [record-learning-validation]\n'
}

run_outside_root_parent_creation_rejection_case() {
  local tmpdir script_root outside_dir out_file rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_record_script_root "$script_root"
  outside_dir="$tmpdir/outside/newdir"
  out_file="$outside_dir/learnings.md"

  set +e
  "$script_root/scripts/record_learning.sh" --out "$out_file" --story AUDIT-003 --note "Outside path should fail" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "record-learning-outside-root" "expected failure for path outside append root" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'rejecting path outside append root' "$tmpdir/out.log"; then
    fail_case "record-learning-outside-root" "expected append root rejection message" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -d "$outside_dir" ]]; then
    fail_case "record-learning-outside-root" "should not create directories outside append root" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [record-learning-outside-root]\n'
}

run_create_and_append_case
run_validation_case
run_outside_root_parent_creation_rejection_case
printf 'All record learning tests passed.\n'
