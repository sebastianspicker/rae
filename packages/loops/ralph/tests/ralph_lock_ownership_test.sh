#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

assert_lock_released_after_owned_run() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh 0 > "$tmpdir/out.log" 2>&1
  )

  if [[ -d "$tmpdir/.runtime/.run.lock" ]]; then
    fail_case "owned-run-release" "lock dir still present" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [owned-run-release]\n'
}

assert_non_owner_does_not_release_lock() {
  local tmpdir holder_pid run_pid run_rc lock_pid
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  mkdir -p "$tmpdir/.runtime/.run.lock"
  sleep 60 &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$tmpdir/.runtime/.run.lock/pid"

  pushd "$tmpdir" >/dev/null
  set +e
  MODE=audit ./ralph.sh 0 > "$tmpdir/out.log" 2>&1 &
  run_pid=$!
  sleep 2
  kill -TERM "$run_pid" 2>/dev/null || true
  wait "$run_pid"
  run_rc=$?
  set -e
  popd >/dev/null

  if [[ ! -d "$tmpdir/.runtime/.run.lock" ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "non-owner-preserve" "lock dir was removed by non-owner" "$tmpdir/out.log" "$tmpdir"
  fi

  lock_pid="$(cat "$tmpdir/.runtime/.run.lock/pid" 2>/dev/null || true)"
  if [[ "$lock_pid" != "$holder_pid" ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "non-owner-preserve" "lock pid changed (expected=$holder_pid got=$lock_pid)" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ "$run_rc" -eq 0 ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "non-owner-preserve" "waiting run unexpectedly succeeded" "$tmpdir/out.log" "$tmpdir"
  fi

  terminate_pid_if_running "$holder_pid"
  cleanup_dir "$tmpdir"
  printf 'PASS [non-owner-preserve]\n'
}

assert_stale_lock_without_pid_is_recovered() {
  local tmpdir run_pid run_rc waited
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  mkdir -p "$tmpdir/.runtime/.run.lock"
  touch -t 200001010000 "$tmpdir/.runtime/.run.lock"

  pushd "$tmpdir" >/dev/null
  set +e
  MODE=audit ./ralph.sh 0 > "$tmpdir/out.log" 2>&1 &
  run_pid=$!
  waited=0
  while kill -0 "$run_pid" 2>/dev/null; do
    if [[ "$waited" -ge 8 ]]; then
      terminate_pid_if_running "$run_pid"
      set -e
      popd >/dev/null
      fail_case "stale-lock-no-pid" "run did not recover stale lock in time" "$tmpdir/out.log" "$tmpdir"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$run_pid"
  run_rc=$?
  set -e
  popd >/dev/null

  if [[ "$run_rc" -ne 0 ]]; then
    fail_case "stale-lock-no-pid" "run failed rc=$run_rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ -d "$tmpdir/.runtime/.run.lock" ]]; then
    fail_case "stale-lock-no-pid" "lock dir still present after recovery" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [stale-lock-no-pid]\n'
}

assert_fresh_lock_without_pid_is_not_stolen() {
  local tmpdir run_pid
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  mkdir -p "$tmpdir/.runtime/.run.lock"

  pushd "$tmpdir" >/dev/null
  set +e
  MODE=audit ./ralph.sh 0 > "$tmpdir/out.log" 2>&1 &
  run_pid=$!
  sleep 5
  if ! kill -0 "$run_pid" 2>/dev/null; then
    wait "$run_pid" 2>/dev/null || true
    set -e
    popd >/dev/null
    fail_case "fresh-lock-no-pid" "waiting run exited and likely stole fresh lock" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -d "$tmpdir/.runtime/.run.lock" ]]; then
    terminate_pid_if_running "$run_pid"
    set -e
    popd >/dev/null
    fail_case "fresh-lock-no-pid" "fresh lock dir disappeared" "$tmpdir/out.log" "$tmpdir"
  fi

  terminate_pid_if_running "$run_pid"
  set -e
  popd >/dev/null

  cleanup_dir "$tmpdir"
  printf 'PASS [fresh-lock-no-pid]\n'
}

assert_lock_released_after_owned_run
assert_non_owner_does_not_release_lock
assert_stale_lock_without_pid_is_recovered
assert_fresh_lock_without_pid_is_not_stolen

printf 'All lock ownership tests passed.\n'
