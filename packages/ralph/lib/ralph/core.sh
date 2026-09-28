# shellcheck shell=bash
# Defines Ralph shared runtime primitives used to keep runs observable and failure handling consistent.

ralph_mktemp_init

# Terminal color constants. Only set when stderr is a TTY, NO_COLOR is not set,
# and --no-color was not passed. See https://no-color.org/
_RALPH_C_RED=""
_RALPH_C_GREEN=""
_RALPH_C_YELLOW=""
_RALPH_C_BLUE=""
_RALPH_C_BOLD=""
_RALPH_C_RESET=""

_ralph_init_colors() {
  if [[ -t 2 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${RALPH_NO_COLOR:-false}" != "true" ]]; then
    _RALPH_C_RED='\033[0;31m'
    _RALPH_C_GREEN='\033[0;32m'
    _RALPH_C_YELLOW='\033[0;33m'
    _RALPH_C_BLUE='\033[0;34m'
    _RALPH_C_BOLD='\033[1m'
    _RALPH_C_RESET='\033[0m'
  fi
}

_ralph_init_colors

# Exit codes for scripts/CI (see README.md). Used by sourced modules and fail().
# shellcheck disable=SC2034
RALPH_EXIT_SUCCESS=0
# shellcheck disable=SC2034
RALPH_EXIT_GENERAL=1
# shellcheck disable=SC2034
RALPH_EXIT_PRD=2
# shellcheck disable=SC2034
RALPH_EXIT_SCOPE=3
# shellcheck disable=SC2034
RALPH_EXIT_TOOL=4
# shellcheck disable=SC2034
RALPH_EXIT_LOCK=5
# shellcheck disable=SC2034
RALPH_EXIT_SECURITY=6

usage() {
  cat <<'USAGE'
Usage: ralph.sh [N] [OPTIONS]

  Process up to N stories for the active mode using Codex CLI.
  If embedded, invoke as: .claude/ralph-audit/ralph.sh [N] [OPTIONS]

Arguments:
  N                          Maximum number of stories to process
                             If omitted: process all remaining open stories for MODE.

Options:
  --mode <mode>              Override MODE env (audit|linting|fixing)
  --search                   Enable Codex web search
  --no-search                Disable web search (default)
  --model-preflight          Run lightweight model preflight check before first story
  --no-model-preflight       Disable model preflight check (default)
  --security-preflight       Enable sensitive env-var preflight warning scan (default)
  --no-security-preflight    Disable security preflight warning scan
  --auto-archive             Auto-archive run state when PRD project value changes
  --no-auto-archive          Disable auto-archive on project change (default)
  --require-learning-entry   Require learnings.md update for successful fixing stories
  --no-require-learning-entry
                             Disable learnings.md enforcement (default)
  --sync-branch              Sync current git branch to PRD branch_name/branchName
  --no-sync-branch           Disable branch sync from PRD (default)
  --model <model>            Override model id (default: gpt-5.3)
  --reasoning-effort <lvl>   Override reasoning effort (default: high)
  --timeout-seconds <secs>   Positive per-story timeout (default: 900)
  --strict-report-dir        Require Created report path under defaults.report_dir (default)
  --no-strict-report-dir     Allow Created report path outside defaults.report_dir for new files
  -q, --quiet                Only errors and final summary
  -v, --verbose              More per-story output
  --validate-prd             Validate PRD only and exit
  --list-stories             List open stories for current mode and exit
  --list-stories-format <f> Output format for --list-stories (full|ids|id+title|json)
  --status                   Show mode, story counts, next story, lock state and exit
  --status-format <f>        Output format for --status (full|compact|json)
  --validate-config          Run full config/PRD/tool/path checks and exit
  --check                    Read-only health check: validate-config + status
  --doctor                   Read-only diagnostics (deps, paths, lock, strict report dir)
  --json                     Machine-readable output mode (sets output format to json)
  --dry-run                  Show what would run without executing the tool
  --aggregate-reports        Write a summary of all reports under report_dir and exit
  --export-state             Write story status (passes/skipped/report_path etc.) as JSON to stdout and exit
  --import-state <file>      Merge story status from <file> into prd.json and exit
  --reset-story <id>         Reset a story to open state for re-processing
  --retry-failed             Reset all skipped stories to open state
  --no-color                 Disable colored output (also respects NO_COLOR env)
  --version                  Show version and exit
  -h, --help                 Show this help

Environment:
  MODE                        Same as --mode
  RALPH_SEARCH_ENABLED_BY_DEFAULT
                              true|false, default false
  RALPH_REPO_ROOT             Optional explicit repo root override
  RALPH_MODEL                 Optional model override
  RALPH_REASONING_EFFORT      Optional reasoning effort override
  RALPH_MAX_ATTEMPTS_PER_STORY
                              Retry budget for transient tool failures per story (default: 1)
  RALPH_SKIP_AFTER_FAILURES   Persistently skip story after N failed runs (default: 0 disabled)
  RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH
                              true|false, require External References section when --search is enabled (default: true)
  RALPH_MODEL_PREFLIGHT       true|false, default false
  RALPH_SECURITY_PREFLIGHT    true|false, default true
  RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK
                              true|false, fail run when sensitive env-vars are detected (default: false)
  RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE
                              true|false, default false
  RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING
                              true|false, default false
  RALPH_SYNC_BRANCH_FROM_PRD  true|false, default false
  RALPH_AUTO_PROGRESS_LOG_APPEND
                              true|false, append progress.log.md entries on story completion (default: true)
  RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS
                              true|false, sync AGENTS.md from latest learnings after fixing stories (default: false)
  RALPH_TIMEOUT_SECONDS       Positive per-story timeout override
  RALPH_CAPTURE_TOOL_OUTPUT   true|false, default false
  RALPH_STRICT_REPORT_DIR     true|false, default true
  RALPH_TRANSACTION_METADATA_ROOT
                              Private absolute non-temp directory for fixing transaction metadata
  RALPH_AUTO_PROGRESS_REFRESH true|false, default true
  RALPH_STALE_LOCK_NO_PID_SECONDS
                              Seconds before a lock dir without valid pid is considered stale (default: 30)
  RALPH_VERBOSITY             normal|quiet|verbose (default: normal). Use -q/-v for quiet/verbose.
  RALPH_OUTPUT_FORMAT         text|json (default: text). If json, emit event lines as JSON to stderr.
  RALPH_STATUS_FORMAT         full|compact|json (optional, default full)
  RALPH_LIST_STORIES_FORMAT   full|ids|id+title|json (optional, default full)
For details and troubleshooting: see README.md
USAGE
}

log() {
  [[ "${RALPH_VERBOSITY:-normal}" == "quiet" ]] && return 0
  printf '%b[ralph]%b %s\n' "$_RALPH_C_BLUE" "$_RALPH_C_RESET" "$*"
}

log_warn() {
  printf '%b[ralph][WARN]%b %s\n' "$_RALPH_C_YELLOW" "$_RALPH_C_RESET" "$*" >&2
}

# Print progress line (overwrites previous when stderr is TTY). Call log_progress_clear once after loop.
log_progress() {
  local current="$1" total="$2" story_id="${3:-}"
  local pct=0
  [[ "${RALPH_VERBOSITY:-normal}" == "quiet" ]] && return 0
  [[ -t 2 ]] || return 0
  [[ "$total" -gt 0 ]] && pct=$(( (current * 100) / total ))
  printf '\r%b[ralph]%b %s%% %s/%s %s    ' "$_RALPH_C_GREEN" "$_RALPH_C_RESET" "$pct" "$current" "$total" "$story_id" >&2
}

log_progress_clear() {
  [[ -t 2 ]] || return 0
  printf '\r%*s\r' 80 "" >&2
}

log_event() {
  local line ts event msg rest msg_escaped
  ts="$(ralph_iso_utc)"
  line="$ts $*"
  if [[ -n "${EVENT_LOG:-}" ]]; then
    printf '%s\n' "$line" >> "$EVENT_LOG"
  fi
  if [[ "${RALPH_OUTPUT_FORMAT:-text}" == "json" ]]; then
    rest="$*"
    event="${rest%% *}"
    msg="${rest#* }"
    msg_escaped="${msg//\\/\\\\}"
    msg_escaped="${msg_escaped//\"/\\\"}"
    msg_escaped="${msg_escaped//$'\n'/\\n}"
    msg_escaped="${msg_escaped//$'\r'/\\r}"
    msg_escaped="${msg_escaped//$'\t'/\\t}"
    msg_escaped="${msg_escaped//$'\f'/\\f}"
    msg_escaped="${msg_escaped//$'\b'/\\b}"
    printf '{"ts":"%s","event":"%s","msg":"%s"}\n' "$ts" "$event" "$msg_escaped" >&2
  fi
}

fail() {
  local code=1 msg hint
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    code="$1"
    msg="${2:-}"
    hint="${3:-}"
  else
    msg="$1"
    hint="${2:-}"
  fi
  printf '%b[ralph][ERROR] %s%b\n' "$_RALPH_C_RED" "$msg" "$_RALPH_C_RESET" >&2
  if [[ -n "$hint" ]]; then
    printf '[ralph] %s\n' "$hint" >&2
  else
    printf '[ralph] See README.md for troubleshooting.\n' >&2
  fi
  if [[ -n "${EVENT_LOG:-}" ]]; then
    log_event "ERROR $msg"
  fi
  exit "$code"
}

register_tmp() {
  TMP_FILES+=("$1")
}

cleanup() {
  local f
  for f in "${TMP_FILES[@]:-}"; do
    if [[ -n "$f" && -e "$f" ]]; then
      rm -f "$f" || true
    fi
  done
}

on_exit() {
  local rc="$1"
  if [[ -n "${ACTIVE_TXN_JOURNAL:-}" ]]; then
    rollback_story_transaction "process-exit" || true
  fi
  release_run_lock
  cleanup
  if [[ "$rc" -ne 0 ]]; then
    printf '[ralph] aborted (exit=%s)\n' "$rc" >&2
  fi
}

on_interrupt() {
  printf '[ralph] interrupted\n' >&2
  exit 130
}

trap 'on_exit $?' EXIT
trap on_interrupt INT TERM

require_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi

  case "$cmd" in
    codex)
      fail "Missing required dependency: $cmd" "Install Codex CLI, or run a read-only check with --check/--doctor"
      ;;
    jq|mktemp)
      fail "Missing required dependency: $cmd" "Install $cmd and re-run; see README.md dependencies"
      ;;
    *)
      fail "Missing required dependency: $cmd"
      ;;
  esac
}

require_runtime_versions() {
  local python_path

  if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 3) )); then
    printf '[ralph][ERROR] Bash >= 5.3 is required (found %s)\n' "$BASH_VERSION" >&2
    exit 1
  fi
  python_path="$(type -P python3 || true)"
  [[ -n "$python_path" ]] || {
    printf '[ralph][ERROR] Python >= 3.14.6 is required (python3 not found)\n' >&2
    exit 1
  }
  if ! PYTHON_EXECUTABLE="$(
    "$python_path" -c '
import os
import sys
if sys.version_info < (3, 14, 6):
    raise SystemExit(1)
print(os.path.realpath(sys.executable))
'
  )"; then
    printf '[ralph][ERROR] Python >= 3.14.6 is required\n' >&2
    exit 1
  fi
}

resolve_codex_executable() {
  local candidate resolved
  candidate="$(type -P codex || true)"
  [[ -n "$candidate" ]] || require_cmd codex
  resolved="$("$PYTHON_EXECUTABLE" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$candidate")"
  [[ "$resolved" == /* && -f "$resolved" && -x "$resolved" ]] \
    || fail "Codex executable did not resolve to an executable file: $candidate"
  if is_path_within_root "$REPO_ROOT_REAL" "$resolved"; then
    fail "Refusing to execute Codex from inside the repository: $resolved"
  fi
  # shellcheck disable=SC2034
  CODEX_EXECUTABLE="$resolved"
}

is_true() {
  [[ "$1" == "true" || "$1" == "1" || "$1" == "yes" ]]
}

is_supported_mode() {
  case "$1" in
    audit|linting|fixing) return 0 ;;
    *) return 1 ;;
  esac
}

require_bool_var() {
  local name="$1"
  local value="$2"

  [[ "$value" == "true" || "$value" == "false" ]] || fail "$name must be true|false"
}

require_nonneg_int_var() {
  local name="$1"
  local value="$2"

  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be a non-negative integer"
}

path_mtime_epoch() {
  local path="$1"
  local mtime

  case "${STAT_FLAVOR:-}" in
    gnu)
      if mtime="$(stat -c '%Y' "$path" 2>/dev/null)"; then
        printf '%s' "$mtime"
        return
      fi
      ;;
    bsd|*)
      if mtime="$(stat -f '%m' "$path" 2>/dev/null)"; then
        printf '%s' "$mtime"
        return
      fi
      ;;
  esac

  fail "Could not read modification time for: $path"
}

detect_stat_flavor() {
  local probe_path
  probe_path="${SCRIPT_DIR:-.}"
  if stat -c '%Y' "$probe_path" >/dev/null 2>&1; then
    STAT_FLAVOR="gnu"
    return
  fi
  if stat -f '%m' "$probe_path" >/dev/null 2>&1; then
    STAT_FLAVOR="bsd"
    return
  fi
  fail "Could not detect compatible stat flavor (need stat -c or stat -f support)"
}

file_state_signature() {
  local abs_path="$1"
  local signature

  case "${STAT_FLAVOR:-}" in
    gnu)
      if signature="$(stat -c '%Y:%Z:%s' "$abs_path" 2>/dev/null)"; then
        printf '%s' "$signature"
        return 0
      fi
      ;;
    bsd|*)
      if signature="$(stat -f '%m:%c:%z' "$abs_path" 2>/dev/null)"; then
        printf '%s' "$signature"
        return 0
      fi
      ;;
  esac

  return 1
}
