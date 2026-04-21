#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

run_warn_case() {
  local tmpdir rc out
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_fixture "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    OPENAI_API_KEY="sk-test-secret" \
    RALPH_SECURITY_PREFLIGHT="true" \
    RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK="false" \
    ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "security-preflight-warn" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  out="$(cat "$tmpdir/out.log")"
  if ! printf '%s' "$out" | grep -q 'Security preflight detected sensitive environment variables'; then
    fail_case "security-preflight-warn" "expected warning output missing" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'OPENAI_API_KEY'; then
    fail_case "security-preflight-warn" "expected variable name missing from warning output" "$tmpdir/out.log" "$tmpdir"
  fi
  if printf '%s' "$out" | grep -q 'sk-test-secret'; then
    fail_case "security-preflight-warn" "secret value leaked in output" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [security-preflight-warn]\n'
}

run_disabled_case() {
  local tmpdir rc out
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_fixture "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    OPENAI_API_KEY="sk-test-secret" \
    RALPH_SECURITY_PREFLIGHT="false" \
    ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "security-preflight-disabled" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  out="$(cat "$tmpdir/out.log")"
  if printf '%s' "$out" | grep -q 'Security preflight detected sensitive environment variables'; then
    fail_case "security-preflight-disabled" "warning should not be emitted when preflight is disabled" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [security-preflight-disabled]\n'
}

run_fail_case() {
  local tmpdir rc out
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/repo"
  prepare_fixture "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    OPENAI_API_KEY="sk-test-secret" \
    RALPH_SECURITY_PREFLIGHT="true" \
    RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK="true" \
    ./ralph.sh 0
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "security-preflight-fail" "expected failure when fail-on-risk is enabled" "$tmpdir/out.log" "$tmpdir"
  fi

  out="$(cat "$tmpdir/out.log")"
  if ! printf '%s' "$out" | grep -q 'Security preflight blocked run due sensitive environment variables'; then
    fail_case "security-preflight-fail" "expected blocking error message missing" "$tmpdir/out.log" "$tmpdir"
  fi
  if printf '%s' "$out" | grep -q 'sk-test-secret'; then
    fail_case "security-preflight-fail" "secret value leaked in output" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [security-preflight-fail]\n'
}

run_warn_case
run_disabled_case
run_fail_case
printf 'All security preflight tests passed.\n'
