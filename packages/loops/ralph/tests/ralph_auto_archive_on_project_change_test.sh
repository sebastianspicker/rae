#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

prepare_repo() {
  local repo_dir="$1"
  prepare_fixture "$repo_dir"
  mkdir -p "$repo_dir/scripts"
  mkdir -p "$repo_dir/scripts/lib"
  cp "$ROOT_DIR/scripts/archive_run_state.sh" "$repo_dir/scripts/archive_run_state.sh"
  cp "$ROOT_DIR/scripts/lib/parse_opts.sh" "$repo_dir/scripts/lib/parse_opts.sh"
  chmod +x "$repo_dir/scripts/archive_run_state.sh"
  mkdir -p "$repo_dir/.runtime"
  mkdir -p "$repo_dir/.claude/ralph-audit/audit"
  printf '# report\n' >"$repo_dir/.claude/ralph-audit/audit/sample.md"
  printf 'old-project\n' >"$repo_dir/.runtime/.last-project"
  printf '# progress\n' >"$repo_dir/progress.txt"
  printf '# learnings\n' >"$repo_dir/learnings.md"
  jq '.project = "new-project"' "$repo_dir/prd.json" >"$repo_dir/prd.tmp.json"
  mv "$repo_dir/prd.tmp.json" "$repo_dir/prd.json"
}

run_case() {
  local tmpdir rc archive_dir
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    MODE=fixing RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE=true ./ralph.sh 0
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "auto-archive-project-change" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  archive_dir="$(find "$tmpdir/repo/archive" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$archive_dir" ]]; then
    fail_case "auto-archive-project-change" "expected archive directory to be created" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/prd.json" ]]; then
    fail_case "auto-archive-project-change" "expected archived prd.json" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/progress.txt" ]]; then
    fail_case "auto-archive-project-change" "expected archived progress.txt" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ "$(cat "$tmpdir/repo/.runtime/.last-project" 2>/dev/null || true)" != "new-project" ]]; then
    fail_case "auto-archive-project-change" "expected .runtime/.last-project to be updated" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [auto-archive-project-change]\n'
}

run_case
printf 'All auto-archive tests passed.\n'
