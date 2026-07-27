#!/usr/bin/env bash
# Regression coverage for Ralph's aggregate reports contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq grep

run_aggregate_reports_case() {
  local tmpdir rc summary
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  mkdir -p "$tmpdir/.claude/ralph-audit/audit/sub"
  printf '# One\n' >"$tmpdir/.claude/ralph-audit/audit/one.md"
  printf '# Two\n' >"$tmpdir/.claude/ralph-audit/audit/sub/two.md"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --aggregate-reports
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "aggregate-reports" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  summary="$tmpdir/.claude/ralph-audit/audit/summary.md"
  if [[ ! -f "$summary" ]]; then
    fail_case "aggregate-reports" "summary.md was not created" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '^- \[one.md\](one.md)$' "$summary"; then
    fail_case "aggregate-reports" "missing expected one.md link" "$summary" "$tmpdir"
  fi
  if ! grep -q '^- \[sub/two.md\](sub/two.md)$' "$summary"; then
    fail_case "aggregate-reports" "missing expected sub/two.md link" "$summary" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [aggregate-reports]\n'
}

run_aggregate_reports_symlink_rejection_case() {
  local tmpdir rc symlink_path outside_dir
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  symlink_path="$tmpdir/.claude/ralph-audit/audit"
  outside_dir="$tmpdir/outside-audit"
  mkdir -p "$tmpdir/.claude/ralph-audit" "$outside_dir"
  rm -rf "$symlink_path"
  ln -s "$outside_dir" "$symlink_path"

  set +e
  (
    cd "$tmpdir"
    ./ralph.sh --aggregate-reports
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "aggregate-reports-symlink-rejection" "expected failure for symlinked report_dir" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -Eq 'Report directory (must not resolve through symlinks|resolves outside repository)' "$tmpdir/out.log"; then
    fail_case "aggregate-reports-symlink-rejection" "expected report directory confinement error" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -e "$outside_dir/summary.md" ]]; then
    fail_case "aggregate-reports-symlink-rejection" "should not write summary outside repository" "$outside_dir/summary.md" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [aggregate-reports-symlink-rejection]\n'
}

run_aggregate_reports_case
run_aggregate_reports_symlink_rejection_case
printf 'All aggregate reports tests passed.\n'
