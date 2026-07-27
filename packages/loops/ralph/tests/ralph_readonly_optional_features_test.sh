#!/usr/bin/env bash
# Regression coverage for Ralph's readonly optional features contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp git

make_fake_codex() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
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
  prepare_runner_and_tool "$repo_dir"

  cat >"$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "readonly-optional-features-test",
  "branch_name": "ralph/should-not-switch",
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
      "title": "Read-only optional feature guard",
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
  local tmpdir bindir rc branch_before branch_after
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo/.runtime"

  make_fake_codex "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  git -C "$tmpdir/repo" init -q
  git -C "$tmpdir/repo" config user.email 'test@example.com'
  git -C "$tmpdir/repo" config user.name 'Test User'
  git -C "$tmpdir/repo" checkout -q -b main
  git -C "$tmpdir/repo" add .
  git -C "$tmpdir/repo" commit -qm 'init'
  printf 'old-project\n' >"$tmpdir/repo/.runtime/.last-project"
  branch_before="$(git -C "$tmpdir/repo" rev-parse --abbrev-ref HEAD)"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
      MODE=audit \
      RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE=true \
      RALPH_SYNC_BRANCH_FROM_PRD=true \
      ./ralph.sh 1
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "readonly-optional-features" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  branch_after="$(git -C "$tmpdir/repo" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch_before" != "$branch_after" ]]; then
    fail_case "readonly-optional-features" "read-only run should not switch branches" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -d "$tmpdir/repo/archive" ]]; then
    fail_case "readonly-optional-features" "read-only run should not auto-archive state" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [readonly-optional-features]\n'
}

run_case
printf 'All read-only optional feature tests passed.\n'
