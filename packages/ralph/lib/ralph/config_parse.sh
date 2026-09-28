# shellcheck shell=bash
# shellcheck disable=SC2034
# CLI argument parsing and runtime config validation.
# Sourced by config.sh; variables set here are used by ralph.sh main().

parse_args() {
  STATUS_FORMAT_EXPLICIT="${STATUS_FORMAT_EXPLICIT:-false}"
  LIST_STORIES_FORMAT_EXPLICIT="${LIST_STORIES_FORMAT_EXPLICIT:-false}"
  JSON_OUTPUT_REQUESTED="${JSON_OUTPUT_REQUESTED:-false}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)
        [[ $# -ge 2 ]] || fail "--mode requires a value"
        MODE="$2"
        shift 2
        ;;
      --search)
        ENABLE_SEARCH="true"
        shift
        ;;
      --no-search)
        ENABLE_SEARCH="false"
        shift
        ;;
      --json)
        JSON_OUTPUT_REQUESTED="true"
        RALPH_OUTPUT_FORMAT="json"
        shift
        ;;
      --sync-branch)
        SYNC_BRANCH_FROM_PRD="true"
        shift
        ;;
      --no-sync-branch)
        SYNC_BRANCH_FROM_PRD="false"
        shift
        ;;
      --model-preflight)
        MODEL_PREFLIGHT="true"
        shift
        ;;
      --no-model-preflight)
        MODEL_PREFLIGHT="false"
        shift
        ;;
      --security-preflight)
        SECURITY_PREFLIGHT="true"
        shift
        ;;
      --no-security-preflight)
        SECURITY_PREFLIGHT="false"
        shift
        ;;
      --auto-archive)
        AUTO_ARCHIVE_ON_PROJECT_CHANGE="true"
        shift
        ;;
      --no-auto-archive)
        AUTO_ARCHIVE_ON_PROJECT_CHANGE="false"
        shift
        ;;
      --require-learning-entry)
        REQUIRE_LEARNING_ENTRY_FOR_FIXING="true"
        shift
        ;;
      --no-require-learning-entry)
        REQUIRE_LEARNING_ENTRY_FOR_FIXING="false"
        shift
        ;;
      --model)
        [[ $# -ge 2 ]] || fail "--model requires a value"
        REQUESTED_MODEL="$2"
        shift 2
        ;;
      --reasoning-effort)
        [[ $# -ge 2 ]] || fail "--reasoning-effort requires a value"
        REASONING_EFFORT="$2"
        shift 2
        ;;
      --timeout-seconds)
        [[ $# -ge 2 ]] || fail "--timeout-seconds requires a value"
        RALPH_TIMEOUT_SECONDS="$2"
        shift 2
        ;;
      --strict-report-dir)
        STRICT_REPORT_DIR="true"
        shift
        ;;
      --no-strict-report-dir)
        STRICT_REPORT_DIR="false"
        shift
        ;;
      -q|--quiet)
        RALPH_VERBOSITY="quiet"
        shift
        ;;
      -v|--verbose)
        RALPH_VERBOSITY="verbose"
        shift
        ;;
      --validate-prd)
        VALIDATE_PRD_ONLY="true"
        shift
        ;;
      --list-stories)
        LIST_STORIES_ONLY="true"
        shift
        ;;
      --list-stories-format)
        [[ $# -ge 2 ]] || fail "--list-stories-format requires a value"
        RALPH_LIST_STORIES_FORMAT="$2"
        LIST_STORIES_FORMAT_EXPLICIT="true"
        shift 2
        ;;
      --list-stories-format=*)
        RALPH_LIST_STORIES_FORMAT="${1#*=}"
        LIST_STORIES_FORMAT_EXPLICIT="true"
        shift
        ;;
      --status)
        STATUS_ONLY="true"
        shift
        ;;
      --status-format)
        [[ $# -ge 2 ]] || fail "--status-format requires a value"
        RALPH_STATUS_FORMAT="$2"
        STATUS_FORMAT_EXPLICIT="true"
        shift 2
        ;;
      --status-format=*)
        RALPH_STATUS_FORMAT="${1#*=}"
        STATUS_FORMAT_EXPLICIT="true"
        shift
        ;;
      --validate-config)
        VALIDATE_CONFIG_ONLY="true"
        shift
        ;;
      --check)
        CHECK_ONLY="true"
        shift
        ;;
      --doctor)
        DOCTOR_ONLY="true"
        shift
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      --aggregate-reports)
        AGGREGATE_REPORTS_ONLY="true"
        shift
        ;;
      --export-state)
        EXPORT_STATE_ONLY="true"
        shift
        ;;
      --import-state)
        [[ $# -ge 2 ]] || fail "Usage: --import-state <state.json>"
        IMPORT_STATE_FILE="$2"
        shift 2
        ;;
      --version)
        printf 'ralph %s\n' "$RALPH_VERSION"
        exit 0
        ;;
      --reset-story)
        [[ $# -ge 2 ]] || fail "--reset-story requires a story id"
        RESET_STORY_ID="$2"
        shift 2
        ;;
      --reset-story=*)
        RESET_STORY_ID="${1#*=}"
        shift
        ;;
      --retry-failed)
        RETRY_FAILED="true"
        shift
        ;;
      --no-color)
        RALPH_NO_COLOR="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        if [[ "$1" =~ ^[0-9]+$ || "$1" == "all_open" ]]; then
          if [[ "$MAX_STORIES_EXPLICIT" == "true" ]]; then
            fail "Only one positional N argument is allowed"
          fi
          MAX_STORIES="$1"
          MAX_STORIES_EXPLICIT="true"
          shift
        else
          fail "Unknown argument: $1"
        fi
        ;;
    esac
  done

  if [[ "$JSON_OUTPUT_REQUESTED" == "true" ]]; then
    if [[ "$STATUS_FORMAT_EXPLICIT" != "true" ]]; then
      RALPH_STATUS_FORMAT="json"
    fi
    if [[ "$LIST_STORIES_FORMAT_EXPLICIT" != "true" ]]; then
      RALPH_LIST_STORIES_FORMAT="json"
    fi
  fi
}

validate_runtime_config() {
  if [[ "$MAX_STORIES_EXPLICIT" == "true" ]]; then
    [[ "$MAX_STORIES" =~ ^[0-9]+$ || "$MAX_STORIES" == "all_open" ]] || fail "Positional argument N (max stories) must be a non-negative integer or 'all_open'"
  fi
  if [[ -n "$MODE" ]]; then
    is_supported_mode "$MODE" || fail "MODE must be one of: $SUPPORTED_MODES_HINT"
  fi
  DEFAULT_MODEL_FALLBACK="gpt-5.3"
  require_bool_var "RALPH_SEARCH_ENABLED_BY_DEFAULT" "$ENABLE_SEARCH"
  [[ "$RALPH_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$RALPH_TIMEOUT_SECONDS" -gt 0 ]] \
    || fail "RALPH_TIMEOUT_SECONDS must be a positive integer"
  [[ "$MAX_ATTEMPTS_PER_STORY" =~ ^[0-9]+$ && "$MAX_ATTEMPTS_PER_STORY" -ge 1 ]] || fail "RALPH_MAX_ATTEMPTS_PER_STORY must be an integer >= 1"
  require_nonneg_int_var "RALPH_SKIP_AFTER_FAILURES" "$SKIP_AFTER_FAILURES"
  require_bool_var "RALPH_CAPTURE_TOOL_OUTPUT" "$CAPTURE_TOOL_OUTPUT"
  require_bool_var "RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH" "$REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH"
  require_bool_var "RALPH_MODEL_PREFLIGHT" "$MODEL_PREFLIGHT"
  require_bool_var "RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE" "$AUTO_ARCHIVE_ON_PROJECT_CHANGE"
  require_bool_var "RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING" "$REQUIRE_LEARNING_ENTRY_FOR_FIXING"
  require_bool_var "RALPH_SECURITY_PREFLIGHT" "$SECURITY_PREFLIGHT"
  require_bool_var "RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK" "$SECURITY_PREFLIGHT_FAIL_ON_RISK"
  require_bool_var "RALPH_SYNC_BRANCH_FROM_PRD" "$SYNC_BRANCH_FROM_PRD"
  require_bool_var "RALPH_AUTO_PROGRESS_LOG_APPEND" "$AUTO_PROGRESS_LOG_APPEND"
  require_bool_var "RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS" "$AUTO_SYNC_AGENTS_FROM_LEARNINGS"
  require_bool_var "RALPH_STRICT_REPORT_DIR" "$STRICT_REPORT_DIR"
  require_bool_var "RALPH_AUTO_PROGRESS_REFRESH" "$AUTO_PROGRESS_REFRESH"
  require_nonneg_int_var "RALPH_STALE_LOCK_NO_PID_SECONDS" "$LOCK_STALE_NO_PID_SECONDS"
  case "${RALPH_OUTPUT_FORMAT:-text}" in
    text|json) ;;
    *) fail "RALPH_OUTPUT_FORMAT must be text|json" ;;
  esac
  case "${RALPH_STATUS_FORMAT:-}" in
    ""|full|compact|json) ;;
    *) fail "RALPH_STATUS_FORMAT must be empty|full|compact|json" ;;
  esac
  case "${RALPH_LIST_STORIES_FORMAT:-full}" in
    full|ids|id+title|json) ;;
    *) fail "RALPH_LIST_STORIES_FORMAT must be full|ids|id+title|json" ;;
  esac
}
