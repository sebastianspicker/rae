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

# Only reclaim locks when the recorded owner is demonstrably stale; a live run
# must never lose ownership merely because its PID was reused or its clock moved.
acquire_run_lock() {
  local lock_dir="$STATE_DIR/.run.lock"
  local attempts=0
  local holder_pid=""
  local lock_dir_mtime=0
  local lock_age=0
  local now_epoch=0
  local holder_identity=""
  local current_identity=""
  local holder_command=""

  while ! mkdir "$lock_dir" 2>/dev/null; do
    holder_pid=""
    if [[ -f "$lock_dir/pid" ]]; then
      holder_pid="$(head -n1 "$lock_dir/pid" 2>/dev/null || true)"
    fi

    # Recover stale lock when holder process no longer exists.
    if [[ "$holder_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -f "$lock_dir/pid" "$lock_dir/process-start" 2>/dev/null || true
      if rmdir "$lock_dir" 2>/dev/null; then
        log_event "INFO recovered_stale_lock method=no_process pid=$holder_pid"
        continue
      fi
    fi

    if [[ "$holder_pid" =~ ^[0-9]+$ ]]; then
      holder_identity=""
      if [[ -f "$lock_dir/process-start" ]]; then
        holder_identity="$(head -n1 "$lock_dir/process-start" 2>/dev/null || true)"
      fi
      if [[ -n "$holder_identity" ]]; then
        current_identity="$(process_start_identity "$holder_pid" || true)"
        if [[ -z "$current_identity" || "$current_identity" != "$holder_identity" ]]; then
          rm -f "$lock_dir/pid" "$lock_dir/process-start" 2>/dev/null || true
          if rmdir "$lock_dir" 2>/dev/null; then
            log_event "INFO recovered_stale_lock method=process_identity pid=$holder_pid"
            continue
          fi
        fi
      elif [[ -d "$lock_dir" ]]; then
        if ! lock_dir_mtime="$(path_mtime_epoch "$lock_dir")"; then
          fail "${RALPH_EXIT_LOCK:-5}" "Could not evaluate lock age for lock directory: $lock_dir"
        fi
        now_epoch="$(date +%s)"
        if [[ "$now_epoch" -lt "$lock_dir_mtime" ]]; then
          lock_age=999999
        else
          lock_age=$((now_epoch - lock_dir_mtime))
        fi
        if [[ "$lock_age" -ge "${LOCK_STALE_UNKNOWN_OWNER_SECONDS:-30}" ]]; then
          holder_command="$(process_command_line "$holder_pid" || true)"
          if [[ "$holder_command" != *ralph.sh* ]]; then
            rm -f "$lock_dir/pid" 2>/dev/null || true
            if rmdir "$lock_dir" 2>/dev/null; then
              log_event "INFO recovered_stale_lock method=legacy_owner age=$lock_age pid=$holder_pid"
              continue
            fi
          fi
        fi
      fi
    else
      if [[ ! -d "$lock_dir" ]]; then
        continue
      fi
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
      if [[ "$lock_age" -ge "${LOCK_STALE_NO_PID_SECONDS:-30}" ]]; then
        if rmdir "$lock_dir" 2>/dev/null; then
          log_event "INFO recovered_stale_lock method=timeout age=$lock_age"
          continue
        fi
      fi
    fi

    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 300 ]]; then
      fail "${RALPH_EXIT_LOCK:-5}" "Another ralph run holds lock at $lock_dir (pid=${holder_pid:-unknown})" "Wait for the active run to finish, or remove a stale lock after verifying no live ralph process owns it"
    fi
    sleep 1
  done

  printf '%s\n' "$$" > "$lock_dir/pid"
  current_identity="$(process_start_identity "$$" || true)"
  if [[ -n "$current_identity" ]]; then
    printf '%s\n' "$current_identity" > "$lock_dir/process-start"
  fi
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
