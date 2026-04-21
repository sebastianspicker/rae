#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

repo=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    j=$((i + 1))
    repo="${!j}"
  fi
done

[[ -n "$repo" ]] && cd "$repo"

case "${FAKE_ACTION:-in_scope}" in
  in_scope)
    mkdir -p docs
    printf 'ok\n' >> docs/allowed.md
    ;;
  out_of_scope)
    mkdir -p src
    printf 'oops\n' > src/outside.txt
    ;;
  ignored_out_of_scope)
    printf 'secret-change\n' >> .env
    ;;
  *)
    printf 'unknown FAKE_ACTION: %s\n' "${FAKE_ACTION:-}" >&2
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
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "scope-enforcement-test",
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
      "title": "Scoped fix",
      "priority": 1,
      "mode": "fixing",
      "scope": ["docs/**"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF

  mkdir -p "$repo_dir/docs"
  printf 'base\n' > "$repo_dir/docs/allowed.md"
  printf 'base-secret\n' > "$repo_dir/.env"
  printf '.env\n' > "$repo_dir/.gitignore"
}

run_case() {
  local name="$1"
  local action="$2"
  local expect_success="$3"
  local expected_snippet="$4"

  local tmpdir bindir rc out
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" FAKE_ACTION="$action" MODE=fixing ./ralph.sh 1
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

run_case "fixing-in-scope" "in_scope" "true" ""
run_case "fixing-out-of-scope" "out_of_scope" "false" "src/outside.txt"
run_case "fixing-ignored-out-of-scope" "ignored_out_of_scope" "false" ".env"

printf 'All scope enforcement tests passed.\n'
