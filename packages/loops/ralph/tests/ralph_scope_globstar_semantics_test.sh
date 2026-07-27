#!/usr/bin/env bash
# Regression coverage for Ralph's scope globstar semantics contract.

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

repo=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    j=$((i + 1))
    repo="${!j}"
  fi
done

[[ -n "$repo" ]] && cd "$repo"

case "${XDG_DATA_HOME:-root_md}" in
  root_md)
    printf 'ok\n' >> README.md
    ;;
  root_tmp)
    printf 'tmp\n' >> cache.tmp
    ;;
  *)
    printf 'unknown XDG_DATA_HOME: %s\n' "${XDG_DATA_HOME:-}" >&2
    exit 1
    ;;
esac

cat >/dev/null
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  local scope_json="$2"

  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<EOF
{
  "schema_version": "1.0.0",
  "project": "scope-globstar-test",
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
      "id": "FIX-001",
      "title": "Scope globstar semantics",
      "priority": 1,
      "mode": "fixing",
      "scope": $scope_json,
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF

  printf 'base\n' > "$repo_dir/README.md"
  printf 'base\n' > "$repo_dir/cache.tmp"
}

run_case() {
  local name="$1"
  local scope_json="$2"
  local action="$3"
  local expect_success="$4"
  local expected_snippet="$5"

  local tmpdir bindir rc out
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo" "$scope_json"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" XDG_DATA_HOME="$action" MODE=fixing ./ralph.sh 1
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
    if ! printf '%s' "$out" | grep -q 'modified files outside scope'; then
      fail_case "$name" "expected scope violation message" "$tmpdir/out.log" "$tmpdir"
    fi
    if [[ -n "$expected_snippet" ]] && ! printf '%s' "$out" | grep -q "$expected_snippet"; then
      fail_case "$name" "expected output snippet not found: $expected_snippet" "$tmpdir/out.log" "$tmpdir"
    fi
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$name"
}

run_case "globstar-allows-root-files" '["**/*"]' "root_md" "true" ""
run_case "globstar-ext-allows-root-md" '["**/*.md"]' "root_md" "true" ""
run_case "globstar-negation-blocks-root-tmp" '["**/*", "!**/*.tmp"]' "root_tmp" "false" "cache.tmp"

printf 'All globstar scope semantics tests passed.\n'
