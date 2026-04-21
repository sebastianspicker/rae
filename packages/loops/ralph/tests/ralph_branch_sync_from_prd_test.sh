#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp git jq

prepare_git_repo_with_fixture() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  (
    cd "$repo_dir"
    git init >/dev/null 2>&1
    git config user.email test@example.com
    git config user.name "Test User"
    printf 'seed\n' >seed.txt
    git add seed.txt
    git commit -m "seed" >/dev/null 2>&1
    git checkout -b main >/dev/null 2>&1 || true
  )

  prepare_fixture "$repo_dir"
  jq '.branch_name = "ralph/feature-sync-test"' "$repo_dir/prd.json" >"$repo_dir/prd.tmp.json"
  mv "$repo_dir/prd.tmp.json" "$repo_dir/prd.json"
}

# Skip when .git/hooks is not writable (e.g. in sandbox).
can_write_git_hooks() {
  local d r
  d="$(mktemp -d)"
  (cd "$d" && git init -q && : >.git/hooks/.keep) 2>/dev/null
  r=$?
  rm -rf "$d"
  return "$r"
}

run_case() {
  local tmpdir rc current_branch
  if ! can_write_git_hooks; then
    printf 'SKIP [branch-sync-from-prd]: .git/hooks not writable (sandbox)\n'
    return 0
  fi
  tmpdir="$(mktemp -d)"
  prepare_git_repo_with_fixture "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    MODE=fixing RALPH_SYNC_BRANCH_FROM_PRD=true ./ralph.sh 0
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "branch-sync-from-prd" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  current_branch="$(git -C "$tmpdir/repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$current_branch" != "ralph/feature-sync-test" ]]; then
    fail_case "branch-sync-from-prd" "expected branch sync to ralph/feature-sync-test, got $current_branch" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [branch-sync-from-prd]\n'
}

run_case
printf 'All branch sync tests passed.\n'
