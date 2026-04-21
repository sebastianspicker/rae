# shellcheck shell=bash

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

  Process up to N stories for the active mode using an AI tool (claude or codex).
  If embedded, invoke as: .claude/ralph-audit/ralph.sh [N] [OPTIONS]

Arguments:
  N                          Maximum number of stories to process
                             If omitted: process all remaining open stories for MODE.

Options:
  --mode <mode>              Override MODE env (audit|linting|fixing)
  --tool <tool>              Runner tool adapter (supported: codex, claude)
  --search                   Enable web search (codex native; logged as warning for claude)
  --no-search                Disable web search (default)
  --model-preflight          Run lightweight model preflight check before first story
  --no-model-preflight       Disable model preflight check (default)
  --security-preflight       Enable sensitive env-var preflight warning scan (default)
  --no-security-preflight    Disable security preflight warning scan
  --skip-security-check      Alias for --no-security-preflight
  --auto-archive             Auto-archive run state when PRD project value changes
  --no-auto-archive          Disable auto-archive on project change (default)
  --require-learning-entry   Require learnings.md update for successful fixing stories
  --no-require-learning-entry
                             Disable learnings.md enforcement (default)
  --sync-branch              Sync current git branch to PRD branch_name/branchName
  --no-sync-branch           Disable branch sync from PRD (default)
  --model <model>            Override model id (default: sonnet for claude, gpt-5.3 for codex)
  --reasoning-effort <lvl>   Override reasoning effort (default: high)
  --timeout-seconds <secs>   Per-story timeout (default: 900, 0 = disabled)
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
  RALPH_TOOL                  Same as --tool (default: claude; also accepts codex)
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
  RALPH_TIMEOUT_SECONDS       Optional timeout override (legacy: CODEX_TIMEOUT_SECONDS)
  RALPH_CAPTURE_TOOL_OUTPUT   true|false, default false
  RALPH_STRICT_REPORT_DIR     true|false, default true
  RALPH_FIXING_STATE_METHOD   auto|full|git (default: auto)
  RALPH_AUTO_PROGRESS_REFRESH true|false, default true
  RALPH_STALE_LOCK_NO_PID_SECONDS
                              Seconds before a lock dir without valid pid is considered stale (default: 30)
  RALPH_VERBOSITY             normal|quiet|verbose (default: normal). Use -q/-v for quiet/verbose.
  RALPH_OUTPUT_FORMAT         text|json (default: text). If json, emit event lines as JSON to stderr.
  RALPH_STATUS_FORMAT         full|compact|json (optional, default full)
  RALPH_LIST_STORIES_FORMAT   full|ids|id+title|json (optional, default full)
  RALPH_CLAUDE_PERMISSION_MODE
                              Override Claude --permission-mode (default: bypassPermissions)

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
    codex|codex-cli)
      fail "Missing required dependency: $cmd" "Install Codex CLI, or run a read-only check with --check/--doctor"
      ;;
    claude)
      fail "Missing required dependency: $cmd" "Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code), or run a read-only check with --check/--doctor"
      ;;
    jq|mktemp)
      fail "Missing required dependency: $cmd" "Install $cmd and re-run; see README.md dependencies"
      ;;
    *)
      fail "Missing required dependency: $cmd"
      ;;
  esac
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
