#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"

if grep -q 'MODEL_PREFLIGHT_OK' <<< "$payload"; then
  if [[ "${RALPH_TEST_PREFLIGHT_OK:-true}" == "true" ]]; then
    printf 'MODEL_PREFLIGHT_OK\n'
  else
    printf 'NOT_OK\n'
  fi
  exit 0
fi

printf '# story report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "model-preflight-test",
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
      "title": "Model Preflight",
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

run_preflight_failure_case() {
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
    RALPH_TEST_PREFLIGHT_OK=false \
    ./ralph.sh --model-preflight 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "model-preflight-failure" "expected preflight failure" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Model preflight check returned unexpected output' "$tmpdir/out.log"; then
    fail_case "model-preflight-failure" "expected preflight failure message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [model-preflight-failure]\n'
}

run_preflight_success_case() {
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
    RALPH_TEST_PREFLIGHT_OK=true \
    ./ralph.sh --model-preflight 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "model-preflight-success" "expected success with valid preflight output, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [model-preflight-success]\n'
}

run_preflight_failure_case
run_preflight_success_case
printf 'All model preflight tests passed.\n'
