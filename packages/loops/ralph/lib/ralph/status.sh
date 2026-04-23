# shellcheck shell=bash
# Status and diagnostics helpers. Depends on config.sh/core.sh/prd.sh globals.

collect_lock_state() {
  local lock_status="not held"
  local lock_flag="not_held"
  local lock_pid=""

  if [[ -n "${STATE_DIR:-}" && -d "${STATE_DIR}/.run.lock" ]]; then
    if [[ -f "${STATE_DIR}/.run.lock/pid" ]]; then
      lock_pid="$(head -n1 "${STATE_DIR}/.run.lock/pid" 2>/dev/null || true)"
      lock_status="held (pid=${lock_pid:-?})"
    else
      lock_status="held (no pid)"
    fi
    lock_flag="held"
  fi

  printf '%s\t%s\t%s' "$lock_flag" "$lock_status" "$lock_pid"
}

show_status() {
  local total passed skipped remaining_total remaining_mode next_id priority
  local lock_tsv lock_flag lock_status lock_pid format

  total="$(jq '[.stories[]] | length' "$PRD_FILE" 2>/dev/null || echo "0")"
  passed="$(jq '[.stories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")"
  skipped="$(jq '[.stories[] | select((.skipped // false) == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")"
  remaining_total=$((total - passed - skipped))
  remaining_mode="$(remaining_count 2>/dev/null || echo "0")"
  next_id="$(next_story_id 2>/dev/null || true)"
  priority=""
  if [[ -n "$next_id" ]]; then
    priority="$(jq -r --arg id "$next_id" '.stories[] | select(.id == $id) | .priority' "$PRD_FILE" 2>/dev/null || echo "?")"
  fi

  lock_tsv="$(collect_lock_state)"
  IFS=$'\t' read -r lock_flag lock_status lock_pid <<< "$lock_tsv"
  format="${RALPH_STATUS_FORMAT:-full}"

  case "$format" in
    compact)
      printf 'mode=%s stories=%s/%s/%s/%s next=%s lock=%s\n' \
        "${MODE:-}" "$total" "$passed" "$skipped" "$remaining_total" \
        "${next_id:-(none)}" "$lock_flag"
      ;;
    json)
      jq -n \
        --arg mode "${MODE:-}" \
        --argjson total "$total" \
        --argjson passed "$passed" \
        --argjson skipped "$skipped" \
        --argjson remaining_total "$remaining_total" \
        --argjson remaining_mode "$remaining_mode" \
        --arg next_id "${next_id:-}" \
        --arg priority "${priority:-}" \
        --arg lock_flag "$lock_flag" \
        --arg lock_status "$lock_status" \
        --arg lock_pid "${lock_pid:-}" \
        '{
          command: "status",
          mode: $mode,
          stories: {
            total: $total,
            passed: $passed,
            skipped: $skipped,
            remaining_total: $remaining_total,
            remaining_mode: $remaining_mode
          },
          next: {
            id: (if $next_id == "" then null else $next_id end),
            priority: (if $priority == "" or $priority == "?" then null else $priority end)
          },
          lock: {
            held: ($lock_flag == "held"),
            status: $lock_status,
            pid: (if $lock_pid == "" then null else $lock_pid end)
          }
        }'
      ;;
    full|*)
      printf 'Mode: %s\n' "${MODE:-}"
      printf 'Stories: %s total, %s passed, %s skipped, %s remaining\n' "$total" "$passed" "$skipped" "$remaining_total"
      printf 'Open in mode (%s): %s\n' "${MODE:-}" "$remaining_mode"
      if [[ -n "$next_id" ]]; then
        printf 'Next: %s (priority %s)\n' "$next_id" "$priority"
      else
        printf 'Next: (none)\n'
      fi
      printf 'Lock: %s\n' "$lock_status"
      ;;
  esac
}

validate_config() {
  local tool_ok="missing"
  local lock_tsv lock_flag lock_status

  [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]] || log "Validating configuration..."
  validate_runtime_config
  validate_prd_structure
  require_cmd jq
  require_cmd mktemp

  case "$TOOL" in
    claude)
      if command -v claude >/dev/null 2>&1; then
        tool_ok="found"
        log_event "INFO validate_config tool (claude) found"
      else
        log_event "WARN validate_config tool (claude) not in PATH"
        [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]] || log_warn "claude not in PATH (required for story runs)"
      fi
      ;;
    *)
      if command -v codex >/dev/null 2>&1 || command -v codex-cli >/dev/null 2>&1; then
        tool_ok="found"
        log_event "INFO validate_config tool (codex) found"
      else
        log_event "WARN validate_config tool (codex) not in PATH"
        [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]] || log_warn "codex/codex-cli not in PATH (required for story runs)"
      fi
      ;;
  esac

  lock_tsv="$(collect_lock_state)"
  IFS=$'\t' read -r lock_flag lock_status _ <<< "$lock_tsv"
  if [[ "$lock_flag" == "held" ]]; then
    log_event "WARN validate_config lock is held"
    [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]] || printf '[ralph][WARN] Lock is currently held at %s\n' "${STATE_DIR}/.run.lock" >&2
  fi

  if [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]]; then
    jq -n \
      --arg mode "${MODE:-}" \
      --arg tool "$tool_ok" \
      --arg lock "$lock_flag" \
      '{
        command: "validate-config",
        ok: true,
        mode: $mode,
        checks: {
          prd: "ok",
          jq: "ok",
          mktemp: "ok",
          tool: $tool,
          lock: $lock
        }
      }'
    return 0
  fi

  printf '[ralph] Checklist: PRD ok, jq ok, mktemp ok, %s %s, lock %s\n' "$TOOL" "$tool_ok" "$lock_flag" >&2
  log "Configuration validation passed."
}

run_check() {
  validate_config
  show_status
}

run_doctor() {
  local tool_cmd="missing"
  local jq_cmd="missing"
  local mktemp_cmd="missing"
  local lock_tsv lock_flag lock_status lock_pid
  local strict_ready="true"
  local strict_reason=""

  case "$TOOL" in
    claude)
      command -v claude >/dev/null 2>&1 && tool_cmd="found"
      ;;
    *)
      { command -v codex >/dev/null 2>&1 || command -v codex-cli >/dev/null 2>&1; } && tool_cmd="found"
      ;;
  esac
  command -v jq >/dev/null 2>&1 && jq_cmd="found"
  command -v mktemp >/dev/null 2>&1 && mktemp_cmd="found"

  lock_tsv="$(collect_lock_state)"
  IFS=$'\t' read -r lock_flag lock_status lock_pid <<< "$lock_tsv"

  if is_true "${STRICT_REPORT_DIR:-true}"; then
    if [[ -z "${DEFAULT_REPORT_DIR:-}" ]]; then
      strict_ready="false"
      strict_reason="defaults.report_dir is empty"
    else
      case "${DEFAULT_REPORT_DIR:-}" in
        *".."*|/*)
          strict_ready="false"
          strict_reason="defaults.report_dir contains unsafe path components"
          ;;
      esac
    fi
  fi

  if [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]]; then
    jq -n \
      --arg mode "${MODE:-}" \
      --arg repo_root "${REPO_ROOT:-}" \
      --arg script_dir "${SCRIPT_DIR:-}" \
      --arg prd_file "${PRD_FILE:-}" \
      --arg state_dir "${STATE_DIR:-}" \
      --arg tool_dep "$tool_cmd" \
      --arg jq_dep "$jq_cmd" \
      --arg mktemp_dep "$mktemp_cmd" \
      --arg lock_flag "$lock_flag" \
      --arg lock_status "$lock_status" \
      --arg lock_pid "${lock_pid:-}" \
      --arg strict_enabled "${STRICT_REPORT_DIR:-true}" \
      --arg default_report_dir "${DEFAULT_REPORT_DIR:-}" \
      --arg strict_ready "$strict_ready" \
      --arg strict_reason "$strict_reason" \
      '{
        command: "doctor",
        mode: $mode,
        paths: {
          repo_root: $repo_root,
          script_dir: $script_dir,
          prd_file: $prd_file,
          state_dir: $state_dir
        },
        dependencies: {
          tool: $tool_dep,
          jq: $jq_dep,
          mktemp: $mktemp_dep
        },
        lock: {
          held: ($lock_flag == "held"),
          status: $lock_status,
          pid: (if $lock_pid == "" then null else $lock_pid end)
        },
        strict_report_dir: {
          enabled: ($strict_enabled == "true"),
          default_report_dir: (if $default_report_dir == "" then null else $default_report_dir end),
          ready: ($strict_ready == "true"),
          reason: (if $strict_reason == "" then null else $strict_reason end)
        }
      }'
    return 0
  fi

  printf 'Doctor Report\n'
  printf 'Mode: %s\n' "${MODE:-}"
  printf 'Repo root: %s\n' "${REPO_ROOT:-}"
  printf 'Script dir: %s\n' "${SCRIPT_DIR:-}"
  printf 'PRD file: %s\n' "${PRD_FILE:-}"
  printf 'State dir: %s\n' "${STATE_DIR:-}"
  printf 'Dependencies: %s=%s jq=%s mktemp=%s\n' "$TOOL" "$tool_cmd" "$jq_cmd" "$mktemp_cmd"
  printf 'Lock: %s\n' "$lock_status"
  if is_true "${STRICT_REPORT_DIR:-true}"; then
    if [[ "$strict_ready" == "true" ]]; then
      printf 'Strict report dir: enabled (ready, defaults.report_dir=%s)\n' "${DEFAULT_REPORT_DIR:-}"
    else
      printf 'Strict report dir: enabled (not ready: %s)\n' "$strict_reason"
    fi
  else
    printf 'Strict report dir: disabled\n'
  fi
}
