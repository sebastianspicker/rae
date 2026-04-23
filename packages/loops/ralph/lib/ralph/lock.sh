# shellcheck shell=bash
# Lock management for single-run mutual exclusion. Depends on STATE_DIR, path_mtime_epoch, log_event, fail.

acquire_run_lock() {
  local lock_dir="$STATE_DIR/.run.lock"
  local attempts=0
  local holder_pid=""
  local lock_dir_mtime=0
  local lock_age=0
  local now_epoch=0

  while ! mkdir "$lock_dir" 2>/dev/null; do
    holder_pid=""
    if [[ -f "$lock_dir/pid" ]]; then
      holder_pid="$(head -n1 "$lock_dir/pid" 2>/dev/null || true)"
    fi

    # Recover stale lock when holder process no longer exists.
    if [[ "$holder_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -f "$lock_dir/pid" 2>/dev/null || true
      if rmdir "$lock_dir" 2>/dev/null; then
        log_event "INFO recovered_stale_lock method=no_process pid=$holder_pid"
        continue
      fi
    fi

    if [[ "$holder_pid" =~ ^[0-9]+$ ]]; then
      :
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
  LOCK_DIR="$lock_dir"
  LOCK_OWNED="true"
}

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

  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  LOCK_OWNED="false"
}
