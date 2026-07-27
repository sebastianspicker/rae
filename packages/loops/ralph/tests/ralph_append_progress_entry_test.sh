#!/usr/bin/env bash
# Regression coverage for Ralph's append progress entry contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

prepare_append_script_root() {
  local dir="$1"
  mkdir -p "$dir/scripts/lib" "$dir/lib/ralph"
  cp "$ROOT_DIR/scripts/append_progress_entry.sh" "$dir/scripts/append_progress_entry.sh"
  cp "$ROOT_DIR/scripts/lib/append_safe.sh" "$dir/scripts/lib/append_safe.sh"
  cp "$ROOT_DIR/scripts/lib/parse_opts.sh" "$dir/scripts/lib/parse_opts.sh"
  cp "$ROOT_DIR/lib/ralph/compat.sh" "$dir/lib/ralph/compat.sh"
}

run_case() {
  local tmpdir script_root out_file rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_append_script_root "$script_root"
  out_file="$script_root/progress.log.md"

  set +e
  "$script_root/scripts/append_progress_entry.sh" --out "$out_file" --story AUDIT-001 --mode audit --title "Audit Title" --report ".claude/ralph-audit/audit/AUDIT-001.md" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "append-progress-entry" "first append should succeed, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$out_file" ]]; then
    fail_case "append-progress-entry" "expected output file to be created" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'AUDIT-001' "$out_file"; then
    fail_case "append-progress-entry" "missing first story entry" "$out_file" "$tmpdir"
  fi

  set +e
  "$script_root/scripts/append_progress_entry.sh" --out "$out_file" --story FIX-001 --mode fixing --title "Fix Title" --report ".claude/ralph-audit/audit/FIX-001.md" >"$tmpdir/out2.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "append-progress-entry" "second append should succeed, got rc=$rc" "$tmpdir/out2.log" "$tmpdir"
  fi
  if [[ "$(grep -c '^### .* UTC | ' "$out_file")" -ne 2 ]]; then
    fail_case "append-progress-entry" "expected two appended entries" "$out_file" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [append-progress-entry]\n'
}

run_symlink_parent_rejection_case() {
  local tmpdir script_root outside_dir link_dir out_file rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_append_script_root "$script_root"
  outside_dir="$tmpdir/outside"
  link_dir="$script_root/link"
  mkdir -p "$outside_dir"
  ln -s "$outside_dir" "$link_dir"
  out_file="$link_dir/progress.log.md"

  set +e
  "$script_root/scripts/append_progress_entry.sh" --out "$out_file" --story AUDIT-002 --mode audit --title "Symlink Title" --report ".claude/ralph-audit/audit/AUDIT-002.md" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "append-progress-entry-symlink-parent" "expected failure for path outside append root" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'rejecting path outside append root' "$tmpdir/out.log"; then
    fail_case "append-progress-entry-symlink-parent" "expected append root rejection message" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -e "$outside_dir/progress.log.md" ]]; then
    fail_case "append-progress-entry-symlink-parent" "should not write through symlinked parent" "$outside_dir/progress.log.md" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [append-progress-entry-symlink-parent]\n'
}

run_outside_root_parent_creation_rejection_case() {
  local tmpdir script_root outside_dir out_file rc
  tmpdir="$(mktemp -d)"
  script_root="$tmpdir/root"
  prepare_append_script_root "$script_root"
  outside_dir="$tmpdir/outside/newdir"
  out_file="$outside_dir/progress.log.md"

  set +e
  "$script_root/scripts/append_progress_entry.sh" --out "$out_file" --story AUDIT-003 --mode audit --title "Outside Title" --report ".claude/ralph-audit/audit/AUDIT-003.md" >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "append-progress-entry-outside-root" "expected failure for path outside append root" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'rejecting path outside append root' "$tmpdir/out.log"; then
    fail_case "append-progress-entry-outside-root" "expected append root rejection message" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -d "$outside_dir" ]]; then
    fail_case "append-progress-entry-outside-root" "should not create directories outside append root" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [append-progress-entry-outside-root]\n'
}

run_case
run_symlink_parent_rejection_case
run_outside_root_parent_creation_rejection_case
printf 'All append progress entry tests passed.\n'
