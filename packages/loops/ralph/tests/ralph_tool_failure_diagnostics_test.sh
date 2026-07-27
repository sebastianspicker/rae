#!/usr/bin/env bash
# Regression coverage for Ralph's tool failure diagnostics contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp grep

make_failing_tool() {
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
printf 'Authorization: Bearer topsecret-token-value\n' >&2
printf 'API_KEY=supersecret-value\n' >&2
printf 'fatal: tool execution failed\n' >&2
exit 42
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "tool-failure-diagnostics-test",
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
      "title": "Tool failure diagnostics",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
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
  local tmpdir bindir rc run_log
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_failing_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit RALPH_CAPTURE_TOOL_OUTPUT=false ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "tool-failure-redaction" "expected failure, got success" "$tmpdir/out.log" "$tmpdir"
  fi

  if ! grep -q 'Codex exec failed for story AUDIT-001' "$tmpdir/out.log"; then
    fail_case "tool-failure-redaction" "missing high-level tool failure message" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '\[REDACTED\]' "$tmpdir/out.log"; then
    fail_case "tool-failure-redaction" "missing redacted error excerpt in stderr output" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'topsecret-token-value' "$tmpdir/out.log"; then
    fail_case "tool-failure-redaction" "stderr leaked bearer token" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'supersecret-value' "$tmpdir/out.log"; then
    fail_case "tool-failure-redaction" "stderr leaked API key value" "$tmpdir/out.log" "$tmpdir"
  fi

  run_log="$tmpdir/repo/.runtime/run.log"
  if [[ ! -f "$run_log" ]]; then
    fail_case "tool-failure-redaction" "missing run log" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '\[REDACTED\]' "$run_log"; then
    fail_case "tool-failure-redaction" "run log missing redaction markers" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'topsecret-token-value' "$run_log"; then
    fail_case "tool-failure-redaction" "run log leaked bearer token" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'supersecret-value' "$run_log"; then
    fail_case "tool-failure-redaction" "run log leaked API key value" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [tool-failure-redaction]\n'
}

run_case
printf 'All tool failure diagnostics tests passed.\n'
