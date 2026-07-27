#!/usr/bin/env bash
# Regression coverage for Ralph's retry budget contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

make_flaky_tool() {
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

count_file="${XDG_STATE_HOME:?missing XDG_STATE_HOME}"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file" 2>/dev/null || echo 0)"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"

cat >/dev/null

if [[ "$count" -lt 2 ]]; then
  printf 'transient failure\n' >&2
  exit 9
fi

printf '# retry success\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "retry-budget-test",
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
      "title": "Retry Budget",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created .claude/ralph-audit/audit/AUDIT-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_success_with_retry_case() {
  local tmpdir bindir rc count_file attempts
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  count_file="$tmpdir/count.txt"

  make_flaky_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_STATE_HOME="$count_file" \
    RALPH_MAX_ATTEMPTS_PER_STORY=2 \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "retry-budget-success" "expected success with retry budget=2, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  attempts="$(cat "$count_file" 2>/dev/null || echo 0)"
  if [[ "$attempts" != "2" ]]; then
    fail_case "retry-budget-success" "expected two attempts, got $attempts" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [retry-budget-success]\n'
}

run_failure_without_retry_case() {
  local tmpdir bindir rc count_file attempts
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  count_file="$tmpdir/count.txt"

  make_flaky_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_STATE_HOME="$count_file" \
    RALPH_MAX_ATTEMPTS_PER_STORY=1 \
    ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "retry-budget-failure" "expected failure with retry budget=1" "$tmpdir/out.log" "$tmpdir"
  fi

  attempts="$(cat "$count_file" 2>/dev/null || echo 0)"
  if [[ "$attempts" != "1" ]]; then
    fail_case "retry-budget-failure" "expected one attempt, got $attempts" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [retry-budget-failure]\n'
}

run_success_with_retry_case
run_failure_without_retry_case
printf 'All retry budget tests passed.\n'
