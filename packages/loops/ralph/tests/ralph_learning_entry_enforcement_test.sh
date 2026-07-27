#!/usr/bin/env bash
# Regression coverage for Ralph's learning entry enforcement contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

last_message=""
repo=""
for ((ralph_i=1; ralph_i<=$#; ralph_i++)); do
  ralph_arg="${!ralph_i}"
  if [[ "$ralph_arg" == "--output-last-message" ]]; then
    ralph_j=$((ralph_i + 1))
    last_message="${!ralph_j}"
  elif [[ "$ralph_arg" == "-C" ]]; then
    ralph_j=$((ralph_i + 1))
    repo="${!ralph_j}"
  fi
done
[[ -z "$repo" ]] || cd "$repo"
[[ -z "$last_message" ]] || exec >"$last_message"
cat >/dev/null

if [[ "${XDG_CONFIG_HOME:-false}" == "true" ]]; then
  printf '\n### 2026-02-17T00:00:00Z UTC | FIX-001\n- Note: Added from test\n' >> "learnings.md"
fi

printf '# fixing report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  cat > "$repo_dir/learnings.md" <<'EOF'
# Ralph Learnings (Append-Only)

## Learning Log
EOF
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "learning-entry-enforcement-test",
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
    "lint_detection_order": [
      "package.json scripts (lint/test)"
    ]
  },
  "stories": [
    {
      "id": "FIX-001",
      "title": "Learning Entry Enforcement",
      "priority": 1,
      "mode": "fixing",
      "scope": [
        "learnings.md"
      ],
      "acceptance_criteria": [
        "Created .claude/ralph-audit/audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_missing_learning_case() {
  local tmpdir bindir rc passes
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_CONFIG_HOME=false \
    RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING=true \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "learning-entry-missing" "expected failure when learnings were not updated" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'requires at least one new learnings.md entry' "$tmpdir/out.log"; then
    fail_case "learning-entry-missing" "expected learnings enforcement message" "$tmpdir/out.log" "$tmpdir"
  fi
  passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  if [[ "$passes" != "false" ]]; then
    fail_case "learning-entry-missing" "story should remain open when learnings enforcement fails" "$tmpdir/repo/prd.json" "$tmpdir"
  fi
  if [[ -f "$tmpdir/repo/.claude/ralph-audit/audit/FIX-001.md" ]]; then
    fail_case "learning-entry-missing" "report file must not be written when learnings enforcement fails" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [learning-entry-missing]\n'
}

run_learning_updated_case() {
  local tmpdir bindir rc passes
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_CONFIG_HOME=true \
    RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING=true \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "learning-entry-updated" "expected success when learnings are updated, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  if [[ "$passes" != "true" ]]; then
    fail_case "learning-entry-updated" "story should be marked passed after valid learnings update" "$tmpdir/repo/prd.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [learning-entry-updated]\n'
}

run_missing_learning_case
run_learning_updated_case
printf 'All learning entry enforcement tests passed.\n'
