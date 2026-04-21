#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap_embedded.sh"

run_basic_bootstrap_case() {
  local tmpdir target_repo rc
  tmpdir="$(mktemp -d)"
  target_repo="$tmpdir/target-repo"
  mkdir -p "$target_repo"

  set +e
  "$BOOTSTRAP_SCRIPT" "$target_repo" > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "bootstrap-basic" "expected bootstrap success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -f "$target_repo/.claude/ralph-audit/ralph.sh" ]]; then
    fail_case "bootstrap-basic" "missing copied ralph.sh" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/prd.json.example" ]]; then
    fail_case "bootstrap-basic" "missing copied prd.json.example" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/LICENSE" ]]; then
    fail_case "bootstrap-basic" "missing copied LICENSE" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/CONTRIBUTING.md" ]]; then
    fail_case "bootstrap-basic" "missing copied CONTRIBUTING.md" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/SECURITY.md" ]]; then
    fail_case "bootstrap-basic" "missing copied SECURITY.md" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/learnings.md" ]]; then
    fail_case "bootstrap-basic" "missing copied learnings.md" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -x "$target_repo/.claude/ralph-audit/ralph.sh" ]]; then
    fail_case "bootstrap-basic" "copied ralph.sh is not executable" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -x "$target_repo/.claude/ralph-audit/scripts/record_learning.sh" ]]; then
    fail_case "bootstrap-basic" "record_learning.sh should be executable" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -x "$target_repo/.claude/ralph-audit/scripts/archive_run_state.sh" ]]; then
    fail_case "bootstrap-basic" "archive_run_state.sh should be executable" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -x "$target_repo/.claude/ralph-audit/scripts/append_progress_entry.sh" ]]; then
    fail_case "bootstrap-basic" "append_progress_entry.sh should be executable" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -x "$target_repo/.claude/ralph-audit/scripts/sync_agents_from_learnings.sh" ]]; then
    fail_case "bootstrap-basic" "sync_agents_from_learnings.sh should be executable" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/skills/prd/SKILL.md" ]]; then
    fail_case "bootstrap-basic" "missing copied PRD skill" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/skills/ralph/SKILL.md" ]]; then
    fail_case "bootstrap-basic" "missing copied Ralph converter skill" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -d "$target_repo/.claude/ralph-audit/docs" ]]; then
    fail_case "bootstrap-basic" "docs/ directory should not be copied (stubs removed)" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -e "$target_repo/.claude/ralph-audit/.claude-plugin" ]]; then
    fail_case "bootstrap-basic" "unexpected .claude-plugin copied in template" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -e "$target_repo/.claude/ralph-audit/flowchart" ]]; then
    fail_case "bootstrap-basic" "unexpected flowchart copied in template" "$tmpdir/out.log" "$tmpdir"
  fi

  set +e
  "$BOOTSTRAP_SCRIPT" "$target_repo" > "$tmpdir/retry.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "bootstrap-basic" "expected failure when destination exists without --force" "$tmpdir/retry.log" "$tmpdir"
  fi

  set +e
  "$BOOTSTRAP_SCRIPT" --force "$target_repo" > "$tmpdir/force.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "bootstrap-basic" "expected success with --force, got rc=$rc" "$tmpdir/force.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [bootstrap-basic]\n'
}

run_with_tests_case() {
  local tmpdir target_repo rc
  tmpdir="$(mktemp -d)"
  target_repo="$tmpdir/target-repo"
  mkdir -p "$target_repo"

  set +e
  "$BOOTSTRAP_SCRIPT" --with-tests "$target_repo" > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "bootstrap-with-tests" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -f "$target_repo/.claude/ralph-audit/tests/ralph_validation_test.sh" ]]; then
    fail_case "bootstrap-with-tests" "expected tests to be copied with --with-tests" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$target_repo/.claude/ralph-audit/tests/lib/test_helpers.sh" ]]; then
    fail_case "bootstrap-with-tests" "expected tests/lib helper copy" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [bootstrap-with-tests]\n'
}

run_basic_bootstrap_case
run_with_tests_case
printf 'All bootstrap embedded tests passed.\n'
