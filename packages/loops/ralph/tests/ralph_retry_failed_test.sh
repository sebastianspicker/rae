#!/usr/bin/env bash
# Regression coverage for Ralph's retry failed contract.

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
  "project": "retry-failed-test",
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
      "title": "Open Story",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-001.md with report"],
      "passes": false
    },
    {
      "id": "AUDIT-002",
      "title": "Skipped Story A",
      "priority": 2,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-002.md with report"],
      "passes": false,
      "skipped": true,
      "skip_reason": "Failed 3 times",
      "skipped_at": "2026-01-01T00:00:00Z"
    },
    {
      "id": "AUDIT-003",
      "title": "Skipped Story B",
      "priority": 3,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-003.md with report"],
      "passes": false,
      "skipped": true,
      "skip_reason": "Failed 2 times",
      "skipped_at": "2026-01-02T00:00:00Z"
    },
    {
      "id": "AUDIT-004",
      "title": "Passed Story",
      "priority": 4,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-004.md with report"],
      "passes": true,
      "completed_at": "2026-01-01T00:00:00Z",
      "report_path": ".claude/ralph-audit/audit/AUDIT-004.md"
    }
  ]
}
EOF
}

run_retry_failed_case() {
  local tmpdir rc s2_skipped s2_passes s3_skipped s3_passes s1_passes s4_passes
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_repo "$tmpdir/repo"

  set +e
  (cd "$tmpdir/repo" && ./ralph.sh --retry-failed) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "retry-failed" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  # Skipped stories should be reset
  s2_skipped="$(jq -r '.stories[1].skipped' "$tmpdir/repo/prd.json")"
  s2_passes="$(jq -r '.stories[1].passes' "$tmpdir/repo/prd.json")"
  s3_skipped="$(jq -r '.stories[2].skipped' "$tmpdir/repo/prd.json")"
  s3_passes="$(jq -r '.stories[2].passes' "$tmpdir/repo/prd.json")"
  if [[ "$s2_skipped" != "false" ]]; then
    fail_case "retry-failed" "AUDIT-002 skipped should be false, got: $s2_skipped" "" "$tmpdir"
  fi
  if [[ "$s2_passes" != "false" ]]; then
    fail_case "retry-failed" "AUDIT-002 passes should be false, got: $s2_passes" "" "$tmpdir"
  fi
  if [[ "$s3_skipped" != "false" ]]; then
    fail_case "retry-failed" "AUDIT-003 skipped should be false, got: $s3_skipped" "" "$tmpdir"
  fi
  if [[ "$s3_passes" != "false" ]]; then
    fail_case "retry-failed" "AUDIT-003 passes should be false, got: $s3_passes" "" "$tmpdir"
  fi

  # Open and passed stories should be untouched
  s1_passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  s4_passes="$(jq -r '.stories[3].passes' "$tmpdir/repo/prd.json")"
  if [[ "$s1_passes" != "false" ]]; then
    fail_case "retry-failed" "AUDIT-001 should remain untouched" "" "$tmpdir"
  fi
  if [[ "$s4_passes" != "true" ]]; then
    fail_case "retry-failed" "AUDIT-004 should remain passed" "" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [retry-failed]\n'
}

run_retry_no_skipped_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_runner_and_tool "$tmpdir/repo"
  cat > "$tmpdir/repo/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "retry-none-test",
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
      "title": "Open Story",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-001.md with report"],
      "passes": false
    }
  ]
}
EOF

  set +e
  (cd "$tmpdir/repo" && ./ralph.sh --retry-failed) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "retry-no-skipped" "expected success even with no skipped stories, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q "No skipped stories found" "$tmpdir/out.log"; then
    fail_case "retry-no-skipped" "expected 'No skipped stories found' message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [retry-no-skipped]\n'
}

run_retry_failed_case
run_retry_no_skipped_case
printf 'All retry-failed tests passed.\n'
