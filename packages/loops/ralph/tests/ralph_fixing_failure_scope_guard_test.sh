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

prompt="$(cat)"

if grep -q 'Story ID: FIX-001' <<< "$prompt"; then
  case "${FAKE_ACTION_FIRST:-in_scope_fail}" in
    in_scope_fail)
      mkdir -p docs/a
      printf 'partial\n' >> docs/a/partial.md
      exit 9
      ;;
    out_of_scope_fail)
      mkdir -p src
      printf 'oops\n' > src/outside.txt
      exit 9
      ;;
    *)
      printf 'unknown FAKE_ACTION_FIRST: %s\n' "${FAKE_ACTION_FIRST:-}" >&2
      exit 1
      ;;
  esac
fi

mkdir -p docs/b
printf 'ok\n' >> docs/b/ok.md
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo_single_story() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "fixing-failure-scope-guard",
  "defaults": {
    "mode_default": "fixing",
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
      "title": "Failing fix",
      "priority": 1,
      "mode": "fixing",
      "scope": ["docs/a/**"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

prepare_repo_two_stories() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "fixing-failure-scope-guard",
  "defaults": {
    "mode_default": "fixing",
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
      "title": "Failing fix",
      "priority": 1,
      "mode": "fixing",
      "scope": ["docs/a/**"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    },
    {
      "id": "FIX-002",
      "title": "Second fix",
      "priority": 2,
      "mode": "fixing",
      "scope": ["docs/b/**"],
      "acceptance_criteria": [
        "Created audit/FIX-002.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_case_out_of_scope_on_failure() {
  local tmpdir bindir rc out
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  prepare_repo_single_story "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" FAKE_ACTION_FIRST="out_of_scope_fail" MODE=fixing ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  out="$(cat "$tmpdir/out.log")"
  if [[ "$rc" -eq 0 ]]; then
    fail_case "fixing-failure-scope-out-of-scope" "expected failure, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'modified files outside scope'; then
    fail_case "fixing-failure-scope-out-of-scope" "expected scope violation on tool failure" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'src/outside.txt'; then
    fail_case "fixing-failure-scope-out-of-scope" "expected out-of-scope path in output" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [fixing-failure-scope-out-of-scope]\n'
}

run_case_skip_updates_fixing_baseline() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  prepare_repo_two_stories "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" FAKE_ACTION_FIRST="in_scope_fail" MODE=fixing RALPH_SKIP_AFTER_FAILURES=1 ./ralph.sh 2
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "fixing-failure-scope-skip-baseline" "expected success after skipping first failing story" "$tmpdir/out.log" "$tmpdir"
  fi

  if ! jq -e '.stories[] | select(.id=="FIX-001" and (.skipped // false) == true)' "$tmpdir/repo/prd.json" >/dev/null; then
    fail_case "fixing-failure-scope-skip-baseline" "expected FIX-001 to be skipped" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! jq -e '.stories[] | select(.id=="FIX-002" and .passes == true)' "$tmpdir/repo/prd.json" >/dev/null; then
    fail_case "fixing-failure-scope-skip-baseline" "expected FIX-002 to pass" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [fixing-failure-scope-skip-baseline]\n'
}

run_case_out_of_scope_on_failure
run_case_skip_updates_fixing_baseline

printf 'All fixing failure scope guard tests passed.\n'
