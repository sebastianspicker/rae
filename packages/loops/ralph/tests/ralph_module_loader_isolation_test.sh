#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

prepare_embedded_repo_without_local_modules() {
  local repo_dir="$1"
  mkdir -p "$repo_dir/.claude/ralph-audit"
  cp "$RUNNER" "$repo_dir/.claude/ralph-audit/ralph.sh"
  cp "$PRD_FILE" "$repo_dir/.claude/ralph-audit/prd.json"
  cp "$PRD_SCHEMA_FILE" "$repo_dir/.claude/ralph-audit/prd.schema.json"
  cp "$PRD_VALIDATE_FILTER_FILE" "$repo_dir/.claude/ralph-audit/prd.validate.jq"
  cp "$POLICY_FILE" "$repo_dir/.claude/ralph-audit/INSTRUCTIONS.md"

  # Malicious fallback modules at repo/lib/ralph must never be sourced by embedded runner.
  mkdir -p "$repo_dir/lib/ralph"
  cat > "$repo_dir/lib/ralph/core.sh" <<'EOF'
# shellcheck shell=bash
printf 'fallback-sourced\n' > ./fallback_marker.txt
usage(){ :; }
log(){ :; }
log_event(){ :; }
fail(){ printf 'MALICIOUS_FALLBACK_USED:%s\n' "$1" >&2; exit 7; }
register_tmp(){ :; }
cleanup(){ :; }
release_run_lock(){ :; }
on_exit(){ :; }
on_interrupt(){ :; }
require_cmd(){ :; }
is_true(){ [[ "$1" == "true" ]]; }
is_supported_mode(){ return 0; }
EOF
}

run_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_embedded_repo_without_local_modules "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    ./.claude/ralph-audit/ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "module-loader-isolation" "expected failure when local module bundle is missing" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Could not locate local lib/ralph modules next to entrypoint' "$tmpdir/out.log"; then
    fail_case "module-loader-isolation" "missing clear module-missing error" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'MALICIOUS_FALLBACK_USED' "$tmpdir/out.log"; then
    fail_case "module-loader-isolation" "embedded runner sourced fallback repo/lib modules" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -f "$tmpdir/repo/fallback_marker.txt" ]]; then
    fail_case "module-loader-isolation" "embedded runner sourced fallback repo/lib modules" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [module-loader-isolation]\n'
}

run_case
printf 'All module loader isolation tests passed.\n'
