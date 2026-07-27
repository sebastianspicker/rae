#!/usr/bin/env bash
# Regression coverage for Ralph's report path dot slash contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

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
printf '# dot slash report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "dot-slash-report-path-test",
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
    "lint_detection_order": [
      "package.json scripts (lint/test)"
    ]
  },
  "stories": [
    {
      "id": "AUDIT-001",
      "title": "Dot slash created path",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created ./.claude/ralph-audit/audit/AUDIT-001.md with report output"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_case() {
  local tmpdir bindir rc report_path
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "report-path-dot-slash" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -f "$tmpdir/repo/.claude/ralph-audit/audit/AUDIT-001.md" ]]; then
    fail_case "report-path-dot-slash" "expected normalized report file to exist" "$tmpdir/out.log" "$tmpdir"
  fi

  report_path="$(jq -r '.stories[0].report_path // ""' "$tmpdir/repo/prd.json")"
  if [[ "$report_path" != ".claude/ralph-audit/audit/AUDIT-001.md" ]]; then
    fail_case "report-path-dot-slash" "report_path should be normalized without leading ./, got=$report_path" "$tmpdir/repo/prd.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [report-path-dot-slash]\n'
}

run_case
printf 'All dot slash report path tests passed.\n'
