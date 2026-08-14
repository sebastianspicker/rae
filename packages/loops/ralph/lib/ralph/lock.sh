# shellcheck shell=bash
# Lock management for single-run mutual exclusion. Depends on STATE_DIR, path_mtime_epoch, log_event, fail.

process_start_identity() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null \
    | head -n1 \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

process_command_line() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null \
    | head -n1 \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

_ralph_lock_set_age() {
  local lock_dir="$1"

  if ! lock_dir_mtime="$(path_mtime_epoch "$lock_dir")"; then
    fail "${RALPH_EXIT_LOCK:-5}" "Could not evaluate lock age for lock directory: $lock_dir"
  fi
  now_epoch="$(date +%s)"
  if [[ "$now_epoch" -lt "$lock_dir_mtime" ]]; then
    # Clock skew: system clock moved backward after lock was created.
    # Treat as stale to prevent deadlock.
    lock_age=999999
  else
    lock_age=$((now_epoch - lock_dir_mtime))
  fi
}

_ralph_try_reclaim_dead_process() {
  local lock_dir="$1"
  local holder_pid="$2"
  local -n reclaim_state_ref="$3"

  rm -f "$lock_dir/pid" "$lock_dir/process-start" 2>/dev/null || true
  if rmdir "$lock_dir" 2>/dev/null; then
    log_event "INFO recovered_stale_lock method=no_process pid=$holder_pid"
    reclaim_state_ref="retry"
  fi
  return 0
}

_ralph_try_reclaim_recorded_identity() {
  local lock_dir="$1"
  local holder_pid="$2"
  local holder_identity="$3"
  local current_identity=""
  local -n reclaim_state_ref="$4"

  current_identity="$(process_start_identity "$holder_pid" || true)"
  if [[ -n "$current_identity" && "$current_identity" == "$holder_identity" ]]; then
    return 0
  fi

  rm -f "$lock_dir/pid" "$lock_dir/process-start" 2>/dev/null || true
  if rmdir "$lock_dir" 2>/dev/null; then
    log_event "INFO recovered_stale_lock method=process_identity pid=$holder_pid"
    reclaim_state_ref="retry"
  fi
  return 0
}

_ralph_try_reclaim_expired_legacy_owner() {
  local lock_dir="$1"
  local holder_pid="$2"
  local lock_age="$3"
  local holder_command=""
  local -n reclaim_state_ref="$4"

  holder_command="$(process_command_line "$holder_pid" || true)"
  if [[ "$holder_command" != *ralph.sh* ]]; then
    rm -f "$lock_dir/pid" 2>/dev/null || true
    if rmdir "$lock_dir" 2>/dev/null; then
      log_event "INFO recovered_stale_lock method=legacy_owner age=$lock_age pid=$holder_pid"
      reclaim_state_ref="retry"
    fi
  fi
  return 0
}

_ralph_try_reclaim_expired_no_pid() {
  local lock_dir="$1"
  local lock_age="$2"
  # shellcheck disable=SC2034 # Nameref assignment updates the caller's retry state.
  local -n reclaim_state_ref="$3"

  if rmdir "$lock_dir" 2>/dev/null; then
    log_event "INFO recovered_stale_lock method=timeout age=$lock_age"
    # shellcheck disable=SC2034 # Nameref assignment updates the caller's retry state.
    reclaim_state_ref="retry"
  fi
  return 0
}

_ralph_try_reclaim_live_owner() {
  local lock_dir="$1"
  local holder_pid="$2"
  local holder_identity=""

  if [[ -f "$lock_dir/process-start" ]]; then
    holder_identity="$(head -n1 "$lock_dir/process-start" 2>/dev/null || true)"
  fi
  if [[ -n "$holder_identity" ]]; then
    _ralph_try_reclaim_recorded_identity "$lock_dir" "$holder_pid" "$holder_identity" "$3"
    return 0
  fi
  if [[ -d "$lock_dir" ]]; then
    _ralph_lock_set_age "$lock_dir"
    if [[ "$lock_age" -ge "${LOCK_STALE_UNKNOWN_OWNER_SECONDS:-30}" ]]; then
      _ralph_try_reclaim_expired_legacy_owner "$lock_dir" "$holder_pid" "$lock_age" "$3"
    fi
  fi
  return 0
}

_ralph_try_reclaim_existing_lock() {
  local lock_dir="$1"
  local -n holder_pid_nameref="$2"
  local -n reclaim_state="$3"

  reclaim_state="wait"

  if [[ "$holder_pid_nameref" =~ ^[0-9]+$ ]]; then
    if ! kill -0 "$holder_pid_nameref" 2>/dev/null; then
      _ralph_try_reclaim_dead_process "$lock_dir" "$holder_pid_nameref" "$3"
    fi
    if [[ "$reclaim_state" != "retry" ]]; then
      _ralph_try_reclaim_live_owner "$lock_dir" "$holder_pid_nameref" "$3"
    fi
    return 0
  fi
  if [[ ! -d "$lock_dir" ]]; then
    reclaim_state="retry"
    return 0
  fi
  _ralph_lock_set_age "$lock_dir"
  if [[ "$lock_age" -ge "${LOCK_STALE_NO_PID_SECONDS:-30}" ]]; then
    _ralph_try_reclaim_expired_no_pid "$lock_dir" "$lock_age" "$3"
  fi
  return 0
}

_ralph_record_lock_owner() {
  local lock_dir="$1"
  local current_identity=""

  printf '%s\n' "$$" > "$lock_dir/pid"
  current_identity="$(process_start_identity "$$" || true)"
  if [[ -n "$current_identity" ]]; then
    printf '%s\n' "$current_identity" > "$lock_dir/process-start"
  fi
}

# Only reclaim locks when the recorded owner is demonstrably stale; a live run
# must never lose ownership merely because its PID was reused or its clock moved.
acquire_run_lock() {
  local lock_dir="$STATE_DIR/.run.lock"
  local attempts=0
  local holder_pid=""
  local lock_dir_mtime=0
  local lock_age=0
  local now_epoch=0
  local reclaim_status=0

  while ! mkdir "$lock_dir" 2>/dev/null; do
    holder_pid=""
    if [[ -f "$lock_dir/pid" ]]; then
      holder_pid="$(head -n1 "$lock_dir/pid" 2>/dev/null || true)"
    fi

    reclaim_status="wait"
    _ralph_try_reclaim_existing_lock "$lock_dir" holder_pid reclaim_status
    if [[ "$reclaim_status" == "retry" ]]; then
      continue
    fi

    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 300 ]]; then
      fail "${RALPH_EXIT_LOCK:-5}" "Another ralph run holds lock at $lock_dir (pid=${holder_pid:-unknown})" "Wait for the active run to finish, or remove a stale lock after verifying no live ralph process owns it"
    fi
    sleep 1
  done

  _ralph_record_lock_owner "$lock_dir"
  LOCK_DIR="$lock_dir"
  LOCK_OWNED="true"
}

# Release only the lock owned by this process so one run cannot unlock another.
release_run_lock() {
  local owner_pid=""

  if [[ "${LOCK_OWNED:-false}" != "true" ]]; then
    return
  fi

  if [[ -z "${LOCK_DIR:-}" || ! -d "$LOCK_DIR" ]]; then
    LOCK_OWNED="false"
    return
  fi

  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner_pid="$(head -n1 "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi

  if [[ "$owner_pid" != "$$" ]]; then
    LOCK_OWNED="false"
    return
  fi

  rm -f "$LOCK_DIR/pid" "$LOCK_DIR/process-start" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  LOCK_OWNED="false"
}
