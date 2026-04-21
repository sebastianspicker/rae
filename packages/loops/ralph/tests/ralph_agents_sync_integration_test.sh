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

cat >> "learnings.md" <<'LEARN'

### 2026-02-17T00:00:00Z UTC | FIX-001
- Note: Keep AGENTS learnings synchronized
LEARN

printf '# fixing report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  mkdir -p "$repo_dir/scripts"
  mkdir -p "$repo_dir/scripts/lib"
  cp "$ROOT_DIR/scripts/sync_agents_from_learnings.sh" "$repo_dir/scripts/sync_agents_from_learnings.sh"
  cp "$ROOT_DIR/scripts/lib/parse_opts.sh" "$repo_dir/scripts/lib/parse_opts.sh"
  cp "$ROOT_DIR/scripts/lib/append_safe.sh" "$repo_dir/scripts/lib/append_safe.sh"
  chmod +x "$repo_dir/scripts/sync_agents_from_learnings.sh"

  cat > "$repo_dir/AGENTS.md" <<'EOF'
# Agent Guide
EOF
  cat > "$repo_dir/learnings.md" <<'EOF'
# Ralph Learnings (Append-Only)

## Learning Log
EOF
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "agents-sync-integration-test",
  "defaults": {
    "mode_default": "fixing",
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
      "id": "FIX-001",
      "title": "AGENTS Sync Integration",
      "priority": 1,
      "mode": "fixing",
      "scope": ["AGENTS.md", "learnings.md"],
      "acceptance_criteria": ["Created .claude/ralph-audit/audit/FIX-001.md with report"],
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
    PATH="$bindir:$PATH" \
    RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING=true \
    RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS=true \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "agents-sync-integration" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Keep AGENTS learnings synchronized' "$tmpdir/repo/AGENTS.md"; then
    fail_case "agents-sync-integration" "expected synced note in AGENTS.md" "$tmpdir/repo/AGENTS.md" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [agents-sync-integration]\n'
}

run_case
printf 'All AGENTS sync integration tests passed.\n'
