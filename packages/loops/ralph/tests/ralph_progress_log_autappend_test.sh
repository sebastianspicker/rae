#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '# progress log report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  mkdir -p "$repo_dir/scripts/lib"
  cp "$ROOT_DIR/scripts/append_progress_entry.sh" "$repo_dir/scripts/append_progress_entry.sh"
  cp "$ROOT_DIR/scripts/lib/append_safe.sh" "$repo_dir/scripts/lib/append_safe.sh"
  cp "$ROOT_DIR/scripts/lib/parse_opts.sh" "$repo_dir/scripts/lib/parse_opts.sh"
  chmod +x "$repo_dir/scripts/append_progress_entry.sh"
  printf '# Ralph Progress Log (Append-Only)\n\n## Entries\n' > "$repo_dir/progress.log.md"
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "progress-log-autappend-test",
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
      "title": "Progress Log Append",
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
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "progress-log-autappend" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'AUDIT-001' "$tmpdir/repo/progress.log.md"; then
    fail_case "progress-log-autappend" "expected appended progress log entry" "$tmpdir/repo/progress.log.md" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [progress-log-autappend]\n'
}

run_case
printf 'All progress log auto-append tests passed.\n'
