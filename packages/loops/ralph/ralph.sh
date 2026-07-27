#!/usr/bin/env bash
# shellcheck disable=SC2034
# Ralph Audit Loop (golden reference template)
#
# Usage examples:
#   MODE=audit   ./ralph.sh 20
#   MODE=linting ./ralph.sh 10
#   MODE=fixing  ./ralph.sh 10
#   MODE=audit   ./.claude/ralph-audit/ralph.sh 20  # embedded layout

set -euo pipefail

RALPH_VERSION="0.3.0"

MODE="${MODE:-}"
MAX_STORIES=""
MAX_STORIES_EXPLICIT="false"
ENABLE_SEARCH="${RALPH_SEARCH_ENABLED_BY_DEFAULT:-false}"
RALPH_TIMEOUT_SECONDS="${RALPH_TIMEOUT_SECONDS:-900}"
REQUESTED_MODEL="${RALPH_MODEL:-}"
REASONING_EFFORT="${RALPH_REASONING_EFFORT:-}"
CAPTURE_TOOL_OUTPUT="${RALPH_CAPTURE_TOOL_OUTPUT:-false}"
MAX_ATTEMPTS_PER_STORY="${RALPH_MAX_ATTEMPTS_PER_STORY:-1}"
REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH="${RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH:-true}"
MODEL_PREFLIGHT="${RALPH_MODEL_PREFLIGHT:-false}"
AUTO_ARCHIVE_ON_PROJECT_CHANGE="${RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE:-false}"
REQUIRE_LEARNING_ENTRY_FOR_FIXING="${RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING:-false}"
SKIP_AFTER_FAILURES="${RALPH_SKIP_AFTER_FAILURES:-0}"
SYNC_BRANCH_FROM_PRD="${RALPH_SYNC_BRANCH_FROM_PRD:-false}"
AUTO_PROGRESS_LOG_APPEND="${RALPH_AUTO_PROGRESS_LOG_APPEND:-true}"
AUTO_SYNC_AGENTS_FROM_LEARNINGS="${RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS:-false}"
SECURITY_PREFLIGHT="${RALPH_SECURITY_PREFLIGHT:-true}"
SECURITY_PREFLIGHT_FAIL_ON_RISK="${RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK:-false}"
LOCK_STALE_NO_PID_SECONDS="${RALPH_STALE_LOCK_NO_PID_SECONDS:-30}"
STRICT_REPORT_DIR="${RALPH_STRICT_REPORT_DIR:-true}"
AUTO_PROGRESS_REFRESH="${RALPH_AUTO_PROGRESS_REFRESH:-true}"
RALPH_VERBOSITY="${RALPH_VERBOSITY:-normal}"
RALPH_OUTPUT_FORMAT="${RALPH_OUTPUT_FORMAT:-text}"
RALPH_STATUS_FORMAT="${RALPH_STATUS_FORMAT:-}"
RALPH_LIST_STORIES_FORMAT="${RALPH_LIST_STORIES_FORMAT:-}"
SUPPORTED_MODES_JSON='["audit","linting","fixing"]'
SUPPORTED_MODES_HINT='audit | linting | fixing'
# shellcheck disable=SC2016
CREATED_AC_REGEX='^Created\s+`?[^`\s]+`?(\s+.*)?$'
DEFAULT_MODE_FALLBACK="audit"
DEFAULT_MODEL_FALLBACK=""
DEFAULT_REASONING_FALLBACK="high"

SCRIPT_DIR=""
REPO_ROOT=""
REPO_ROOT_REAL=""
TOOL_REPO_ROOT=""
PRD_FILE=""
PRD_SCHEMA_FILE=""
PRD_VALIDATE_FILTER_FILE=""
POLICY_FILE=""
STATE_DIR=""
STATE_DIR_REAL=""
TRANSACTION_METADATA_ROOT=""
RUN_LOG=""
EVENT_LOG=""
SANDBOX_MODE=""
LOCK_DIR=""
LOCK_OWNED="false"
STAT_FLAVOR=""
DEFAULT_REPORT_DIR=""
MAX_STORIES_DEFAULT="all_open"

processed=0
passed=0
VALIDATE_PRD_ONLY="false"
LIST_STORIES_ONLY="false"
STATUS_ONLY="false"
VALIDATE_CONFIG_ONLY="false"
DRY_RUN="false"
AGGREGATE_REPORTS_ONLY="false"
EXPORT_STATE_ONLY="false"
IMPORT_STATE_FILE=""
CHECK_ONLY="false"
DOCTOR_ONLY="false"
STATUS_FORMAT_EXPLICIT="false"
LIST_STORIES_FORMAT_EXPLICIT="false"
JSON_OUTPUT_REQUESTED="false"
RUN_STARTED_EPOCH=""

TMP_FILES=()
DETECTED_CHECKS=()
DETECTED_CHECKS_READY="false"
STORY_CACHE_ID=""
STORY_CACHE_TITLE=""
STORY_CACHE_NOTES=""
STORY_CACHE_OBJECTIVE=""
STORY_CACHE_CREATED_LINE=""
STORY_CACHE_SCOPE_PATTERNS=()
STORY_CACHE_ACCEPTANCE_LINES=()
STORY_CACHE_STEP_LINES=()
STORY_CACHE_VERIFICATION_LINES=()
STORY_CACHE_OUT_OF_SCOPE_LINES=()
RESET_STORY_ID=""
RETRY_FAILED="false"
RALPH_NO_COLOR="${RALPH_NO_COLOR:-false}"
PYTHON_EXECUTABLE=""
CODEX_EXECUTABLE=""
ACTIVE_TXN_JOURNAL=""
ACTIVE_LEARNINGS_BASELINE_SIGNATURE="__missing__"

RALPH_ENTRYPOINT="${BASH_SOURCE[0]}"
RALPH_LIB_DIR=""

resolve_lib_dir() {
  local entry_dir
  entry_dir="$(cd "$(dirname "$RALPH_ENTRYPOINT")" && pwd)"

  if [[ -d "$entry_dir/lib/ralph" ]]; then
    RALPH_LIB_DIR="$entry_dir/lib/ralph"
    return
  fi

  printf '[ralph][ERROR] Could not locate local lib/ralph modules next to entrypoint: %s/lib/ralph\n' "$entry_dir" >&2
  exit 1
}

source_module() {
  local module="$1"
  local path="$RALPH_LIB_DIR/$module"
  if [[ ! -f "$path" ]]; then
    printf '[ralph][ERROR] Missing module: %s\n' "$path" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$path"
}

resolve_lib_dir
source_module compat.sh
source_module core.sh
source_module config.sh
source_module prd.sh
source_module status.sh
source_module prompt.sh
source_module aggregate.sh
source_module state_io.sh
source_module runner.sh

main() {
  require_runtime_versions
  parse_args "$@"
  validate_runtime_config

  resolve_script_dir
  resolve_repo_root
  REPO_ROOT_REAL="$(cd "$REPO_ROOT" && pwd -P)"
  TOOL_REPO_ROOT="$REPO_ROOT_REAL"
  if [[ "$CHECK_ONLY" == "true" || "$DOCTOR_ONLY" == "true" ]]; then
    resolve_paths_readonly
  else
    resolve_paths
  fi

  if [[ "$VALIDATE_PRD_ONLY" == "true" ]]; then
    validate_prd_structure
    log "PRD validation passed."
    exit 0
  fi

  if [[ "$CHECK_ONLY" == "true" ]]; then
    validate_prd_structure
    load_default_report_dir
    apply_prd_runtime_defaults
    finalize_runtime_config
    run_check
    exit 0
  fi

  if [[ "$DOCTOR_ONLY" == "true" ]]; then
    validate_prd_structure
    load_default_report_dir
    apply_prd_runtime_defaults
    finalize_runtime_config
    run_doctor
    exit 0
  fi

  if [[ "$STATUS_ONLY" == "true" ]]; then
    validate_prd_structure
    load_default_report_dir
    apply_prd_runtime_defaults
    finalize_runtime_config
    show_status
    exit 0
  fi

  if [[ "$VALIDATE_CONFIG_ONLY" == "true" ]]; then
    validate_config
    exit 0
  fi

  if [[ "$AGGREGATE_REPORTS_ONLY" == "true" ]]; then
    validate_prd_structure
    load_default_report_dir
    apply_prd_runtime_defaults
    finalize_runtime_config
    aggregate_reports
    exit 0
  fi

  if [[ "$EXPORT_STATE_ONLY" == "true" ]]; then
    validate_prd_structure
    require_cmd jq
    export_prd_state
    exit 0
  fi

  if [[ -n "$IMPORT_STATE_FILE" ]]; then
    detect_stat_flavor
    acquire_run_lock
    validate_prd_structure
    require_cmd jq
    import_prd_state "$IMPORT_STATE_FILE"
    exit 0
  fi

  if [[ -n "$RESET_STORY_ID" ]]; then
    detect_stat_flavor
    acquire_run_lock
    validate_prd_structure
    require_cmd jq
    reset_story "$RESET_STORY_ID"
    exit 0
  fi

  if [[ "$RETRY_FAILED" == "true" ]]; then
    detect_stat_flavor
    acquire_run_lock
    validate_prd_structure
    require_cmd jq
    reset_skipped_stories
    exit 0
  fi

  if [[ "$LIST_STORIES_ONLY" == "true" ]]; then
    validate_prd_structure
    load_default_report_dir
    apply_prd_runtime_defaults
    finalize_runtime_config
    list_open_stories
    exit 0
  fi

  detect_stat_flavor
  acquire_run_lock
  recover_story_transaction
  run_security_preflight_check

  require_cmd jq
  require_cmd mktemp
  if command -v git >/dev/null 2>&1; then
    log_event "INFO git detected"
  else
    log_event "INFO git not detected"
  fi

  validate_prd_structure
  load_default_report_dir
  apply_prd_runtime_defaults
  finalize_runtime_config
  mode_to_sandbox
  maybe_sync_branch_from_prd
  maybe_auto_archive_on_project_change

  RUN_STARTED_EPOCH="$(date +%s)"

  if [[ "$MAX_STORIES_EXPLICIT" != "true" ]]; then
    if [[ "$MAX_STORIES_DEFAULT" == "all_open" ]]; then
      MAX_STORIES="$(remaining_count)"
      log "no N provided; processing all remaining open stories for mode=$MODE (count=$MAX_STORIES)"
    else
      MAX_STORIES="$MAX_STORIES_DEFAULT"
      log "no N provided; using defaults.max_stories_default=$MAX_STORIES for mode=$MODE"
    fi
  fi

  # Normalize positional "all_open" to current remaining count so the loop runs correctly.
  if [[ "$MAX_STORIES" == "all_open" ]]; then
    MAX_STORIES="$(remaining_count)"
    log "processing all remaining open stories for mode=$MODE (count=$MAX_STORIES)"
  fi

  if [[ "$MAX_STORIES" -gt 0 ]]; then
    resolve_codex_executable
    maybe_run_model_preflight_check
  else
    log_event "INFO codex dependency check skipped (max_stories=0)"
  fi

  log "start mode=$MODE tool=codex max_stories=$MAX_STORIES sandbox=$SANDBOX_MODE"
  log_event "RUN_START mode=$MODE tool=codex max_stories=$MAX_STORIES sandbox=$SANDBOX_MODE search=$ENABLE_SEARCH"

  while [[ "$processed" -lt "$MAX_STORIES" ]]; do
    local story_id
    local story_rc=0
    story_id="$(select_next_open_story)"

    if [[ -z "$story_id" ]]; then
      break
    fi

    processed=$((processed + 1))
    if [[ "${RALPH_VERBOSITY:-normal}" != "quiet" ]]; then
      if [[ -t 2 ]]; then
        log_progress "$processed" "$MAX_STORIES" "$story_id"
      else
        log "Processing story $processed/$MAX_STORIES ($story_id)"
      fi
    fi
    if process_story "$story_id"; then
      if ! is_true "${DRY_RUN:-false}"; then
        passed=$((passed + 1))
      fi
    else
      story_rc=$?
      handle_story_failure "$story_id" "$story_rc"
    fi
  done

  log_progress_clear
  local remaining run_elapsed now_epoch
  remaining="$(remaining_count)"
  now_epoch="$(date +%s)"
  if [[ -n "$RUN_STARTED_EPOCH" && "$now_epoch" -ge "$RUN_STARTED_EPOCH" ]]; then
    run_elapsed=$((now_epoch - RUN_STARTED_EPOCH))
  else
    run_elapsed=0
  fi

  log "summary processed=$processed passed=$passed remaining=$remaining mode=$MODE tool=codex elapsed=${run_elapsed}s"
  log_event "RUN_END processed=$processed passed=$passed remaining=$remaining mode=$MODE tool=codex elapsed_seconds=$run_elapsed"

  if [[ "$processed" -gt 0 && "${RALPH_VERBOSITY:-normal}" != "quiet" && "${RALPH_OUTPUT_FORMAT:-text}" == "text" ]]; then
    local failed=$((processed - passed))
    log "${_RALPH_C_BOLD}── Run Summary ──────────────────${_RALPH_C_RESET}"
    log "  Mode:      $MODE"
    log "  Processed: $processed"
    log "  Passed:    ${_RALPH_C_GREEN}${passed}${_RALPH_C_RESET}"
    if [[ "$failed" -gt 0 ]]; then
      log "  Failed:    ${_RALPH_C_RED}${failed}${_RALPH_C_RESET}"
    else
      log "  Failed:    $failed"
    fi
    log "  Remaining: $remaining"
    log "  Elapsed:   ${run_elapsed}s"
    log "${_RALPH_C_BOLD}─────────────────────────────────${_RALPH_C_RESET}"
  fi
  if [[ "$remaining" -eq 0 ]]; then
    printf '<promise>COMPLETE</promise>\n'
    if [[ "${RALPH_VERBOSITY:-normal}" != "quiet" ]]; then
      log "All stories complete."
    fi
  fi
}

main "$@"
