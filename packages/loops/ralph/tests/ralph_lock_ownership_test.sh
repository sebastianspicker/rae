#!/usr/bin/env bash
# Regression coverage for Ralph's lock ownership and stale-lock contracts.
# shellcheck disable=SC1090,SC1091,SC2034,SC2329

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp ps

LOCK_SOURCE="$LIB_DIR/lock.sh"

assert_file_contents() {
  local case_name="$1"
  local path="$2"
  local expected="$3"
  local actual
  actual="$(cat "$path" 2>/dev/null || true)"
  if [[ "$actual" != "$expected" ]]; then
    fail_case "$case_name" "expected '$expected' in $path, got '$actual'" "" "${path%/*}"
  fi
}

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

assert_owner_term_releases_lock() {
  local tmpdir run_pid run_rc waited
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state"

  bash -c '
    STATE_DIR="$1"
    EVENT_LOG="$2"
    LIB_DIR="$3"
    LOCK_SOURCE="$4"
    LOCK_OWNED="false"
    LOCK_DIR=""
    source "$LIB_DIR/compat.sh"
    source "$LOCK_SOURCE"
    source "$LIB_DIR/core.sh"
    acquire_run_lock
    while true; do
      command sleep 1
    done
  ' bash "$tmpdir/state" "$tmpdir/events.log" "$LIB_DIR" "$LOCK_SOURCE" > "$tmpdir/out.log" 2>&1 &
  run_pid=$!

  waited=0
  while [[ ! -f "$tmpdir/state/.run.lock/pid" || "$(cat "$tmpdir/state/.run.lock/pid" 2>/dev/null || true)" != "$run_pid" ]]; do
    if [[ "$waited" -ge 20 ]]; then
      terminate_pid_if_running "$run_pid"
      fail_case "owner-term-release" "owner did not publish its pid" "$tmpdir/out.log" "$tmpdir"
    fi
    command sleep 0.1
    waited=$((waited + 1))
  done
  set +e
  kill -TERM "$run_pid"
  wait "$run_pid"
  run_rc=$?
  set -e

  if [[ "$run_rc" -ne 130 ]]; then
    fail_case "owner-term-release" "TERM exited $run_rc instead of 130" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ -d "$tmpdir/state/.run.lock" ]]; then
    fail_case "owner-term-release" "owner lock remained after TERM" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [owner-term-release]\n'
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
  printf 'PASS [non-owner-term-preserve]\n'
}

assert_dead_pid_reclaims_and_logs() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state/.run.lock"
  printf '4242\n' > "$tmpdir/state/.run.lock/pid"
  printf 'obsolete identity\n' > "$tmpdir/state/.run.lock/process-start"

  (
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    LOCK_OWNED="false"
    source "$LOCK_SOURCE"
    kill() { return 1; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/sleeps.log"; }
    acquire_run_lock
    release_run_lock
  )

  assert_file_contents "dead-pid-log" "$tmpdir/events.log" "INFO recovered_stale_lock method=no_process pid=4242"
  if [[ -s "$tmpdir/sleeps.log" ]]; then
    fail_case "dead-pid-immediate-retry" "recovery slept before retry" "" "$tmpdir"
  fi
  cleanup_dir "$tmpdir"
  printf 'PASS [dead-pid-reclaim]\n'
}

assert_matching_identity_is_preserved() {
  local tmpdir holder_pid run_rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state/.run.lock"
  sleep 60 &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$tmpdir/state/.run.lock/pid"
  ps -p "$holder_pid" -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' > "$tmpdir/state/.run.lock/process-start"

  set +e
  (
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    LOCK_STALE_UNKNOWN_OWNER_SECONDS=0
    source "$LOCK_SOURCE"
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/sleeps.log"; }
    acquire_run_lock
  ) > "$tmpdir/out.log" 2>&1
  run_rc=$?
  set -e

  if [[ "$run_rc" -ne 5 ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "matching-identity-preserve" "expected lock failure 5, got $run_rc" "$tmpdir/out.log" "$tmpdir"
  fi
  assert_file_contents "matching-identity-pid" "$tmpdir/state/.run.lock/pid" "$holder_pid"
  if [[ ! -s "$tmpdir/state/.run.lock/process-start" || -e "$tmpdir/events.log" ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "matching-identity-preserve" "matching owner was changed or logged as stale" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ "$(wc -l < "$tmpdir/sleeps.log" | tr -d ' ')" != "299" ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "matching-identity-sleeps" "expected 299 retry sleeps" "$tmpdir/out.log" "$tmpdir"
  fi

  terminate_pid_if_running "$holder_pid"
  cleanup_dir "$tmpdir"
  printf 'PASS [matching-identity-preserve]\n'
}

assert_recorded_identity_mismatch_reclaims() {
  local tmpdir holder_pid
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state/.run.lock"
  sleep 60 &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$tmpdir/state/.run.lock/pid"
  printf 'not the holder start\n' > "$tmpdir/state/.run.lock/process-start"

  (
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    source "$LOCK_SOURCE"
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/sleeps.log"; }
    acquire_run_lock
    release_run_lock
  )

  assert_file_contents "identity-mismatch-log" "$tmpdir/events.log" "INFO recovered_stale_lock method=process_identity pid=$holder_pid"
  if [[ -s "$tmpdir/sleeps.log" ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "identity-mismatch-immediate-retry" "recovery slept before retry" "" "$tmpdir"
  fi
  terminate_pid_if_running "$holder_pid"
  cleanup_dir "$tmpdir"
  printf 'PASS [recorded-identity-mismatch]\n'
}

assert_legacy_lock_threshold_behavior() {
  local tmpdir holder_pid run_rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state/.run.lock"
  sleep 60 &
  holder_pid=$!
  printf '%s\n' "$holder_pid" > "$tmpdir/state/.run.lock/pid"

  set +e
  (
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    LOCK_STALE_UNKNOWN_OWNER_SECONDS=30
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { printf '129\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { :; }
    acquire_run_lock
  ) > "$tmpdir/fresh.log" 2>&1
  run_rc=$?
  set -e
  if [[ "$run_rc" -ne 5 ]]; then
    terminate_pid_if_running "$holder_pid"
    fail_case "legacy-fresh" "expected lock failure 5, got $run_rc" "$tmpdir/fresh.log" "$tmpdir"
  fi
  assert_file_contents "legacy-fresh-pid" "$tmpdir/state/.run.lock/pid" "$holder_pid"

  (
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    LOCK_STALE_UNKNOWN_OWNER_SECONDS=30
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { printf '130\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { :; }
    acquire_run_lock
    release_run_lock
  )
  assert_file_contents "legacy-expired-log" "$tmpdir/events.log" "INFO recovered_stale_lock method=legacy_owner age=30 pid=$holder_pid"

  terminate_pid_if_running "$holder_pid"
  cleanup_dir "$tmpdir"
  printf 'PASS [legacy-fresh-expired-threshold]\n'
}

assert_missing_and_malformed_pid_behavior() {
  local tmpdir run_rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/missing/.run.lock" "$tmpdir/malformed/.run.lock"
  printf 'not-a-pid\n' > "$tmpdir/malformed/.run.lock/pid"

  (
    STATE_DIR="$tmpdir/missing"
    EVENT_LOG="$tmpdir/missing-events.log"
    LOCK_STALE_NO_PID_SECONDS=30
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { printf '130\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    acquire_run_lock
    release_run_lock
  )
  assert_file_contents "missing-pid-log" "$tmpdir/missing-events.log" "INFO recovered_stale_lock method=timeout age=30"

  set +e
  (
    STATE_DIR="$tmpdir/malformed"
    EVENT_LOG="$tmpdir/malformed-events.log"
    LOCK_STALE_NO_PID_SECONDS=30
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { printf '130\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { :; }
    acquire_run_lock
  ) > "$tmpdir/malformed.log" 2>&1
  run_rc=$?
  set -e
  if [[ "$run_rc" -ne 5 ]]; then
    fail_case "malformed-pid" "expected lock failure 5, got $run_rc" "$tmpdir/malformed.log" "$tmpdir"
  fi
  assert_file_contents "malformed-pid-preserved" "$tmpdir/malformed/.run.lock/pid" "not-a-pid"
  if [[ -e "$tmpdir/malformed-events.log" ]]; then
    fail_case "malformed-pid-log" "malformed pid lock was logged as reclaimed" "$tmpdir/malformed.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [missing-and-malformed-pid]\n'
}

assert_clock_backward_and_rmdir_failure() {
  local tmpdir run_rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/future/.run.lock" "$tmpdir/rmdir-failure/.run.lock"
  printf '4242\n' > "$tmpdir/rmdir-failure/.run.lock/pid"

  (
    STATE_DIR="$tmpdir/future"
    EVENT_LOG="$tmpdir/future-events.log"
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '200\n'; }
    date() { printf '100\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    acquire_run_lock
    release_run_lock
  )
  assert_file_contents "clock-backward-log" "$tmpdir/future-events.log" "INFO recovered_stale_lock method=timeout age=999999"

  set +e
  (
    STATE_DIR="$tmpdir/rmdir-failure"
    EVENT_LOG="$tmpdir/rmdir-events.log"
    source "$LOCK_SOURCE"
    kill() { return 1; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    rmdir() { return 1; }
    sleep() { :; }
    acquire_run_lock
  ) > "$tmpdir/rmdir.log" 2>&1
  run_rc=$?
  set -e
  if [[ "$run_rc" -ne 5 ]]; then
    fail_case "rmdir-failure" "expected lock failure 5, got $run_rc" "$tmpdir/rmdir.log" "$tmpdir"
  fi
  if [[ -e "$tmpdir/rmdir-events.log" ]]; then
    fail_case "rmdir-failure-log" "logged recovery despite failed rmdir" "$tmpdir/rmdir.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [clock-backward-and-rmdir-failure]\n'
}

assert_date_failure_under_errexit_preserves_lock() {
  local tmpdir run_rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/state/.run.lock"

  set +e
  (
    set -e
    STATE_DIR="$tmpdir/state"
    EVENT_LOG="$tmpdir/events.log"
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { return 23; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/sleeps.log"; }
    acquire_run_lock
  ) > "$tmpdir/date-failure.log" 2>&1
  run_rc=$?
  set -e

  if [[ "$run_rc" -ne 23 ]]; then
    fail_case "date-failure" "expected date exit 23, got $run_rc" "$tmpdir/date-failure.log" "$tmpdir"
  fi
  if [[ ! -d "$tmpdir/state/.run.lock" || -e "$tmpdir/state/.run.lock/pid" ]]; then
    fail_case "date-failure" "date failure changed stale lock or published an owner" "$tmpdir/date-failure.log" "$tmpdir"
  fi
  if [[ -e "$tmpdir/events.log" || -e "$tmpdir/sleeps.log" ]]; then
    fail_case "date-failure" "date failure logged recovery or slept" "$tmpdir/date-failure.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [date-failure-under-errexit]\n'
}

assert_logger_failure_matches_errexit_modes() {
  local tmpdir run_rc lock_pid
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/errexit/.run.lock" "$tmpdir/no-errexit/.run.lock"
  printf '4242\n' > "$tmpdir/errexit/.run.lock/pid"
  printf '4242\n' > "$tmpdir/no-errexit/.run.lock/pid"

  set +e
  (
    set -e
    STATE_DIR="$tmpdir/errexit"
    EVENT_LOG="$tmpdir/errexit-events.log"
    source "$LOCK_SOURCE"
    kill() { return 1; }
    log_event() { return 17; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/errexit-sleeps.log"; }
    acquire_run_lock
  ) > "$tmpdir/errexit.log" 2>&1
  run_rc=$?
  set -e

  if [[ "$run_rc" -ne 17 ]]; then
    fail_case "logger-failure-errexit" "expected logger exit 17, got $run_rc" "$tmpdir/errexit.log" "$tmpdir"
  fi
  if [[ -d "$tmpdir/errexit/.run.lock" || -e "$tmpdir/errexit/.run.lock/pid" || -e "$tmpdir/errexit-sleeps.log" ]]; then
    fail_case "logger-failure-errexit" "logger failure did not abort after stale removal" "$tmpdir/errexit.log" "$tmpdir"
  fi

  (
    set +e
    STATE_DIR="$tmpdir/no-errexit"
    EVENT_LOG="$tmpdir/no-errexit-events.log"
    source "$LOCK_SOURCE"
    kill() { return 1; }
    log_event() { return 17; }
    fail() { exit "${1:-1}"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/no-errexit-sleeps.log"; }
    acquire_run_lock
    lock_pid="$(cat "$STATE_DIR/.run.lock/pid")"
    if [[ -z "$lock_pid" || "$lock_pid" == "4242" ]]; then
      exit 91
    fi
    release_run_lock
  ) > "$tmpdir/no-errexit.log" 2>&1

  if [[ -e "$tmpdir/no-errexit-sleeps.log" ]]; then
    fail_case "logger-failure-no-errexit" "logger failure slept before reacquiring" "$tmpdir/no-errexit.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [logger-failure-errexit-modes]\n'
}

assert_retry_limit_and_space_paths() {
  local tmpdir state_dir run_rc sleep_count sleep_args
  tmpdir="$(mktemp -d)"
  state_dir="$tmpdir/state with spaces"
  mkdir -p "$state_dir/.run.lock"

  set +e
  (
    STATE_DIR="$state_dir"
    EVENT_LOG="$tmpdir/events.log"
    LOCK_STALE_NO_PID_SECONDS=30
    source "$LOCK_SOURCE"
    path_mtime_epoch() { printf '100\n'; }
    date() { printf '100\n'; }
    log_event() { printf '%s\n' "$1" >> "$EVENT_LOG"; }
    fail() { printf 'fail:%s:%s\n' "$1" "$2" >&2; exit "$1"; }
    sleep() { printf '%s\n' "$1" >> "$tmpdir/sleeps.log"; }
    acquire_run_lock
  ) > "$tmpdir/retry.log" 2>&1
  run_rc=$?
  set -e
  if [[ "$run_rc" -ne 5 ]]; then
    fail_case "retry-limit" "expected lock failure 5, got $run_rc" "$tmpdir/retry.log" "$tmpdir"
  fi
  sleep_count="$(wc -l < "$tmpdir/sleeps.log" | tr -d ' ')"
  sleep_args="$(sort -u "$tmpdir/sleeps.log")"
  if [[ "$sleep_count" != "299" || "$sleep_args" != "1" ]]; then
    fail_case "retry-limit" "expected 299 one-second sleeps, got count=$sleep_count args=$sleep_args" "$tmpdir/retry.log" "$tmpdir"
  fi
  if ! rg -F "Another ralph run holds lock at $state_dir/.run.lock (pid=unknown)" "$tmpdir/retry.log" >/dev/null; then
    fail_case "retry-limit-diagnostic" "missing exact lock diagnostic" "$tmpdir/retry.log" "$tmpdir"
  fi
  if [[ ! -d "$state_dir/.run.lock" ]]; then
    fail_case "space-path" "lock path containing spaces was changed" "$tmpdir/retry.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [retry-limit-and-space-path]\n'
}

assert_lock_released_after_owned_run
assert_owner_term_releases_lock
assert_non_owner_does_not_release_lock
assert_dead_pid_reclaims_and_logs
assert_matching_identity_is_preserved
assert_recorded_identity_mismatch_reclaims
assert_legacy_lock_threshold_behavior
assert_missing_and_malformed_pid_behavior
assert_clock_backward_and_rmdir_failure
assert_date_failure_under_errexit_preserves_lock
assert_logger_failure_matches_errexit_modes
assert_retry_limit_and_space_paths

printf 'All lock ownership tests passed.\n'
