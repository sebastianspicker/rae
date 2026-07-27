#!/usr/bin/env bash
# Regression coverage for Ralph's prd defaults precedence contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp grep

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
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo_mode_default() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "defaults-precedence-test",
  "defaults": {
    "mode_default": "linting",
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
      "id": "LINT-001",
      "title": "Lint mode default",
      "priority": 1,
      "mode": "linting",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created audit/LINT-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

prepare_repo_max_default() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "defaults-max-stories-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": 1,
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
      "title": "First",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created audit/AUDIT-001.md with report"
      ],
      "passes": false
    },
    {
      "id": "AUDIT-002",
      "title": "Second",
      "priority": 2,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created audit/AUDIT-002.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

assert_mode_in_output() {
  local case_name="$1"
  local log_file="$2"
  local expected_mode="$3"
  if ! grep -q "mode=$expected_mode" "$log_file"; then
    fail_case "$case_name" "expected mode=$expected_mode in output" "$log_file"
  fi
}

run_mode_precedence_cases() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo_mode_default "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    unset MODE
    PATH="$bindir:$PATH" ./ralph.sh 0
  ) > "$tmpdir/case-default.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "mode-from-prd-default" "expected success, got rc=$rc" "$tmpdir/case-default.log" "$tmpdir"
  fi
  assert_mode_in_output "mode-from-prd-default" "$tmpdir/case-default.log" "linting"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=fixing ./ralph.sh 0
  ) > "$tmpdir/case-env.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "mode-env-overrides-prd" "expected success, got rc=$rc" "$tmpdir/case-env.log" "$tmpdir"
  fi
  assert_mode_in_output "mode-env-overrides-prd" "$tmpdir/case-env.log" "fixing"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit ./ralph.sh --mode linting 0
  ) > "$tmpdir/case-cli.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "mode-cli-overrides-env" "expected success, got rc=$rc" "$tmpdir/case-cli.log" "$tmpdir"
  fi
  assert_mode_in_output "mode-cli-overrides-env" "$tmpdir/case-cli.log" "linting"

  cleanup_dir "$tmpdir"
  printf 'PASS [mode-precedence]\n'
}

run_max_stories_default_case() {
  local tmpdir bindir rc passes_true
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo_max_default "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    unset MODE
    PATH="$bindir:$PATH" ./ralph.sh
  ) > "$tmpdir/case-max.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "max-stories-default" "expected success, got rc=$rc" "$tmpdir/case-max.log" "$tmpdir"
  fi

  passes_true="$(jq '[.stories[] | select(.passes == true)] | length' "$tmpdir/repo/prd.json")"
  if [[ "$passes_true" != "1" ]]; then
    fail_case "max-stories-default" "expected exactly one story pass with default max_stories=1, got $passes_true" "$tmpdir/case-max.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [max-stories-default]\n'
}

run_mode_precedence_cases
run_max_stories_default_case
printf 'All PRD defaults precedence tests passed.\n'
