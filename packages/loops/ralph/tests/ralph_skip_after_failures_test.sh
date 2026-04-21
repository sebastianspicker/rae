#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

make_failing_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf 'permanent failure\n' >&2
exit 17
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "skip-after-failures-test",
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
      "title": "Skip After Failures",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/AUDIT-001.md with report"],
      "passes": false
    }
  ]
}
EOF
}

run_case() {
  local tmpdir bindir rc skipped passes skip_reason
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_failing_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    RALPH_MAX_ATTEMPTS_PER_STORY=1 \
    RALPH_SKIP_AFTER_FAILURES=1 \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "skip-after-failures" "expected success due skip circuit breaker, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  skipped="$(jq -r '.stories[0].skipped // false' "$tmpdir/repo/prd.json")"
  passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  skip_reason="$(jq -r '.stories[0].skip_reason // ""' "$tmpdir/repo/prd.json")"
  if [[ "$skipped" != "true" ]]; then
    fail_case "skip-after-failures" "story should be marked skipped" "$tmpdir/repo/prd.json" "$tmpdir"
  fi
  if [[ "$passes" != "false" ]]; then
    fail_case "skip-after-failures" "skipped story must remain passes=false" "$tmpdir/repo/prd.json" "$tmpdir"
  fi
  if [[ -z "$skip_reason" ]]; then
    fail_case "skip-after-failures" "skip_reason should be populated" "$tmpdir/repo/prd.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [skip-after-failures]\n'
}

run_case
printf 'All skip-after-failures tests passed.\n'
