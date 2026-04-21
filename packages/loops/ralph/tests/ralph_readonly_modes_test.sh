#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

make_fake_claude() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

disallowed=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "--disallowedTools" ]]; then
    j=$((i + 1))
    disallowed="${!j}"
  fi
done

if [[ "$disallowed" != *"Bash"* ]]; then
  printf 'mutation should have been blocked\n' > SHOULD_NOT_EXIST.txt
fi

cat >/dev/null
printf '# fake read-only report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat >"$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "readonly-modes-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": "all_open",
    "model_default": "gpt-5.3",
    "reasoning_effort_default": "high",
    "report_dir": "audit",
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
      "title": "Read-only story",
      "priority": 1,
      "mode": "audit",
      "scope": ["docs/**"],
      "acceptance_criteria": [
        "Created audit/AUDIT-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_case() {
  local name="$1"
  local mode="$2"
  local permission_mode="${3:-}"
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_claude "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE="$mode" RALPH_CLAUDE_PERMISSION_MODE="$permission_mode" ./ralph.sh 1
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "$name" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -e "$tmpdir/repo/SHOULD_NOT_EXIST.txt" ]]; then
    fail_case "$name" "read-only mode allowed a Bash-backed mutation" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$name"
}

run_case "readonly-audit-blocks-bash" "audit"
run_case "readonly-linting-blocks-bash" "linting"
run_case "readonly-audit-override-still-blocks-bash" "audit" "acceptEdits"
printf 'All read-only mode tests passed.\n'
