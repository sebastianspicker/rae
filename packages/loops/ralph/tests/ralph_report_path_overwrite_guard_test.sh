#!/usr/bin/env bash
# Regression coverage for Ralph's report path overwrite guard contract.

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
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  local created_line="$2"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<EOF
{
  "schema_version": "1.0.0",
  "project": "report-path-overwrite-guard-test",
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
      "title": "Report path guard",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "$created_line"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_case() {
  local name="$1"
  local created_line="$2"
  local seed_target_path="$3"
  local expect_success="$4"
  local expected_snippet="$5"
  local strict_report_dir="${6:-true}"
  local skip_after_failures="${7:-0}"

  local tmpdir bindir rc out
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo" "$created_line"

  if [[ -n "$seed_target_path" ]]; then
    mkdir -p "$(dirname "$tmpdir/repo/$seed_target_path")"
    printf 'existing-content\n' > "$tmpdir/repo/$seed_target_path"
  fi

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit RALPH_STRICT_REPORT_DIR="$strict_report_dir" RALPH_SKIP_AFTER_FAILURES="$skip_after_failures" ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  out="$(cat "$tmpdir/out.log")"
  if [[ "$expect_success" == "true" ]]; then
    if [[ "$rc" -ne 0 ]]; then
      fail_case "$name" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
    fi
  else
    if [[ "$rc" -eq 0 ]]; then
      fail_case "$name" "expected failure, got success" "$tmpdir/out.log" "$tmpdir"
    fi
    if [[ -n "$expected_snippet" ]] && ! printf '%s' "$out" | grep -q "$expected_snippet"; then
      fail_case "$name" "expected output snippet not found: $expected_snippet" "$tmpdir/out.log" "$tmpdir"
    fi
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$name"
}

run_case \
  "strict-default-blocks-path-outside-report-dir" \
  "Created docs/new-report.md with report" \
  "" \
  "false" \
  "Report path must stay under defaults.report_dir"

run_case \
  "strict-default-still-fails-with-skip-after-enabled" \
  "Created docs/new-report.md with report" \
  "" \
  "false" \
  "Report path must stay under defaults.report_dir" \
  "true" \
  "1"

run_case \
  "allow-outside-report-dir-when-strict-disabled" \
  "Created docs/new-report.md with report" \
  "" \
  "true" \
  "" \
  "false"

run_case \
  "allow-existing-report-file-under-report-dir" \
  "Created audit/AUDIT-001.md with report" \
  "audit/AUDIT-001.md" \
  "true" \
  ""

run_case \
  "block-existing-non-report-file-when-strict-disabled" \
  "Created README.md with report" \
  "README.md" \
  "false" \
  "Refusing to overwrite existing non-report file: README.md" \
  "false"

printf 'All report path overwrite guard tests passed.\n'
