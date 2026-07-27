#!/usr/bin/env bash
# Regression coverage for Ralph's reset story contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "reset-story-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": "all_open",
    "model_default": "gpt-5.3",
    "reasoning_effort_default": "high",
    "report_dir": ".claude/ralph-audit/audit",
    "sandbox_by_mode": {
      "audit": "read-only",
      "linting": "read-only",
      "fixing": "workspace-write"
    },
    "lint_detection_order": ["package.json scripts (lint/test)"]
  },
  "stories": [
    {
      "id": "AUDIT-001",
      "title": "Passed Story",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-001.md with report"],
      "passes": true,
      "completed_at": "2026-01-01T00:00:00Z",
      "report_path": "audit/AUDIT-001.md"
    },
    {
      "id": "AUDIT-002",
      "title": "Skipped Story",
      "priority": 2,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-002.md with report"],
      "passes": false,
      "skipped": true,
      "skip_reason": "Skipped after 3 failed runs (last_rc=1)",
      "skipped_at": "2026-01-02T00:00:00Z"
    }
  ]
}
EOF
}

run_reset_passed_case() {
  local tmpdir rc passes completed report_path
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_repo "$tmpdir/repo"

  set +e
  (cd "$tmpdir/repo" && ./ralph.sh --reset-story AUDIT-001) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "reset-passed-story" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  completed="$(jq -r '.stories[0].completed_at // "null"' "$tmpdir/repo/prd.json")"
  report_path="$(jq -r '.stories[0].report_path // "null"' "$tmpdir/repo/prd.json")"
  if [[ "$passes" != "false" ]]; then
    fail_case "reset-passed-story" "passes should be false, got: $passes" "" "$tmpdir"
  fi
  if [[ "$completed" != "null" ]]; then
    fail_case "reset-passed-story" "completed_at should be removed, got: $completed" "" "$tmpdir"
  fi
  if [[ "$report_path" != "null" ]]; then
    fail_case "reset-passed-story" "report_path should be removed, got: $report_path" "" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [reset-passed-story]\n'
}

run_reset_skipped_case() {
  local tmpdir rc passes skipped skip_reason skipped_at
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_repo "$tmpdir/repo"

  set +e
  (cd "$tmpdir/repo" && ./ralph.sh --reset-story AUDIT-002) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "reset-skipped-story" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  passes="$(jq -r '.stories[1].passes' "$tmpdir/repo/prd.json")"
  skipped="$(jq -r '.stories[1].skipped' "$tmpdir/repo/prd.json")"
  skip_reason="$(jq -r '.stories[1].skip_reason // "null"' "$tmpdir/repo/prd.json")"
  skipped_at="$(jq -r '.stories[1].skipped_at // "null"' "$tmpdir/repo/prd.json")"
  if [[ "$passes" != "false" ]]; then
    fail_case "reset-skipped-story" "passes should be false, got: $passes" "" "$tmpdir"
  fi
  if [[ "$skipped" != "false" ]]; then
    fail_case "reset-skipped-story" "skipped should be false, got: $skipped" "" "$tmpdir"
  fi
  if [[ "$skip_reason" != "null" ]]; then
    fail_case "reset-skipped-story" "skip_reason should be removed, got: $skip_reason" "" "$tmpdir"
  fi
  if [[ "$skipped_at" != "null" ]]; then
    fail_case "reset-skipped-story" "skipped_at should be removed, got: $skipped_at" "" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [reset-skipped-story]\n'
}

run_reset_invalid_id_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_repo "$tmpdir/repo"

  set +e
  (cd "$tmpdir/repo" && ./ralph.sh --reset-story NONEXISTENT) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "reset-invalid-id" "expected failure for invalid story id, got rc=0" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [reset-invalid-id]\n'
}

run_reset_passed_case
run_reset_skipped_case
run_reset_invalid_id_case
printf 'All reset-story tests passed.\n'
