# shellcheck shell=bash
# shellcheck disable=SC2034
# Loads and validates Ralph runtime configuration so execution policy stays explicit and deterministic.

_ralph_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ralph/validate_prd.sh
source "$_ralph_lib/validate_prd.sh"
# shellcheck source=lib/ralph/config_parse.sh
source "$_ralph_lib/config_parse.sh"
# shellcheck source=lib/ralph/preflight.sh
source "$_ralph_lib/preflight.sh"

resolve_script_dir() {
  local entry="${RALPH_ENTRYPOINT:-${BASH_SOURCE[0]}}"
  SCRIPT_DIR="$(cd "$(dirname "$entry")" && pwd)"
}

resolve_repo_root() {
  local candidate

  if [[ -n "${RALPH_REPO_ROOT:-}" ]]; then
    [[ -d "$RALPH_REPO_ROOT" ]] || fail "RALPH_REPO_ROOT does not exist: $RALPH_REPO_ROOT"
    REPO_ROOT="$(cd "$RALPH_REPO_ROOT" && pwd)"
    return
  fi

  # 1) Check current working directory first - if it has prd.json and a policy file, it's likely the intended root.
  if [[ -f "prd.json" ]] && [[ -f "INSTRUCTIONS.md" ]]; then
    REPO_ROOT="$(pwd)"
    return
  fi

  # 2) Embedded layout marker: <repo>/.claude/ralph-audit
  local embedded_parent
  embedded_parent="$(basename "$(dirname "$SCRIPT_DIR")")"
  if [[ "$(basename "$SCRIPT_DIR")" == "ralph-audit" ]] && [[ "$embedded_parent" == ".claude" ]]; then
    candidate="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [[ -f "$candidate/$embedded_parent/ralph-audit/prd.json" ]] && [[ -f "$candidate/$embedded_parent/ralph-audit/INSTRUCTIONS.md" ]]; then
      REPO_ROOT="$candidate"
      return
    fi
  fi

  # 3) Standalone template layout: script lives at repository root.
  if [[ -f "$SCRIPT_DIR/prd.json" ]] && [[ -f "$SCRIPT_DIR/INSTRUCTIONS.md" ]]; then
    REPO_ROOT="$SCRIPT_DIR"
    return
  fi

  # 4) Fallback to git toplevel if script is in a git repo
  if command -v git >/dev/null 2>&1; then
    if candidate="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
      REPO_ROOT="$candidate"
      return
    fi
  fi

  fail "Could not resolve repository root. Set RALPH_REPO_ROOT explicitly."
}

_resolve_policy_file() {
  POLICY_FILE="$SCRIPT_DIR/INSTRUCTIONS.md"
}

resolve_paths() {
  local state_dir_real

  PRD_FILE="$SCRIPT_DIR/prd.json"
  PRD_SCHEMA_FILE="$SCRIPT_DIR/prd.schema.json"
  PRD_VALIDATE_FILTER_FILE="$SCRIPT_DIR/prd.validate.jq"
  _resolve_policy_file
  STATE_DIR="$SCRIPT_DIR/.runtime"
  RUN_LOG="$STATE_DIR/run.log"
  EVENT_LOG="$STATE_DIR/events.log"

  mkdir -p "$STATE_DIR"
  state_dir_real="$(cd "$STATE_DIR" && pwd -P)" || fail "Could not resolve runtime state directory: $STATE_DIR"
  if [[ "$state_dir_real" != "$REPO_ROOT_REAL" && "$state_dir_real" != "$REPO_ROOT_REAL/"* ]]; then
    fail "Runtime state directory resolves outside repository: $STATE_DIR -> $state_dir_real"
  fi
  STATE_DIR_REAL="$state_dir_real"
  touch "$RUN_LOG" "$EVENT_LOG"
}

resolve_paths_readonly() {
  local state_dir_real

  PRD_FILE="$SCRIPT_DIR/prd.json"
  PRD_SCHEMA_FILE="$SCRIPT_DIR/prd.schema.json"
  PRD_VALIDATE_FILTER_FILE="$SCRIPT_DIR/prd.validate.jq"
  _resolve_policy_file
  STATE_DIR="$SCRIPT_DIR/.runtime"
  RUN_LOG=""
  EVENT_LOG=""
  if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
    state_dir_real="$(cd "$STATE_DIR" && pwd -P)" || fail "Could not resolve runtime state directory: $STATE_DIR"
    if [[ "$state_dir_real" != "$REPO_ROOT_REAL" && "$state_dir_real" != "$REPO_ROOT_REAL/"* ]]; then
      fail "Runtime state directory resolves outside repository: $STATE_DIR -> $state_dir_real"
    fi
    STATE_DIR_REAL="$state_dir_real"
  else
    STATE_DIR_REAL="$(cd "$(dirname "$STATE_DIR")" && pwd -P)/$(basename "$STATE_DIR")"
  fi
}

mode_to_sandbox() {
  local configured_sandbox
  configured_sandbox="$(jq -r --arg mode "$MODE" '.defaults.sandbox_by_mode[$mode] // ""' "$PRD_FILE" 2>/dev/null || true)"
  case "$configured_sandbox" in
  read-only | workspace-write)
    SANDBOX_MODE="$configured_sandbox"
    ;;
  *)
    fail "Invalid sandbox_by_mode mapping for mode=$MODE in $PRD_FILE"
    ;;
  esac
}

apply_prd_runtime_defaults() {
  local prd_mode prd_model prd_reason prd_max

  prd_mode="$(jq -r '.defaults.mode_default // ""' "$PRD_FILE")"
  prd_model="$(jq -r '.defaults.model_default // ""' "$PRD_FILE")"
  prd_reason="$(jq -r '.defaults.reasoning_effort_default // ""' "$PRD_FILE")"
  prd_max="$(jq -r '
    if .defaults.max_stories_default == "all_open" then
      "all_open"
    elif (.defaults.max_stories_default | type) == "number" then
      (.defaults.max_stories_default | floor | tostring)
    else
      ""
    end
  ' "$PRD_FILE")"

  if [[ -z "$MODE" ]]; then
    MODE="$prd_mode"
  fi
  if [[ -z "$REQUESTED_MODEL" ]]; then
    REQUESTED_MODEL="$prd_model"
  fi
  if [[ -z "$REASONING_EFFORT" ]]; then
    REASONING_EFFORT="$prd_reason"
  fi

  # shellcheck disable=SC2153
  [[ -n "$MODE" ]] || MODE="$DEFAULT_MODE_FALLBACK"
  [[ -n "$REQUESTED_MODEL" ]] || REQUESTED_MODEL="$DEFAULT_MODEL_FALLBACK"
  [[ -n "$REASONING_EFFORT" ]] || REASONING_EFFORT="$DEFAULT_REASONING_FALLBACK"

  if [[ -n "$prd_max" ]]; then
    MAX_STORIES_DEFAULT="$prd_max"
  else
    MAX_STORIES_DEFAULT="all_open"
  fi
}

finalize_runtime_config() {
  is_supported_mode "$MODE" || fail "MODE must be one of: $SUPPORTED_MODES_HINT"
  [[ -n "$REQUESTED_MODEL" ]] || fail "Model must not be empty"
  case "$REASONING_EFFORT" in
  low | medium | high) ;;
  *) fail "Reasoning effort must be one of: low|medium|high" ;;
  esac

  if [[ "$MAX_STORIES_DEFAULT" == "all_open" ]]; then
    :
  elif [[ "$MAX_STORIES_DEFAULT" =~ ^[0-9]+$ ]]; then
    :
  else
    fail "defaults.max_stories_default resolved to invalid value: $MAX_STORIES_DEFAULT"
  fi
}

validate_prd_structure() {
  [[ -f "$PRD_FILE" ]] || fail "${RALPH_EXIT_PRD:-2}" "Missing PRD file: $PRD_FILE" "Create prd.json (e.g. from prd.json.example) or run from repository root"
  [[ -f "$POLICY_FILE" ]] || fail "${RALPH_EXIT_PRD:-2}" "Missing policy file: $POLICY_FILE" "Add INSTRUCTIONS.md or run from repository root"
  [[ -f "$PRD_SCHEMA_FILE" ]] || fail "${RALPH_EXIT_PRD:-2}" "Missing PRD schema file: $PRD_SCHEMA_FILE" "Run from template or embedded repo root"
  [[ -f "$PRD_VALIDATE_FILTER_FILE" ]] || fail "${RALPH_EXIT_PRD:-2}" "Missing PRD validation filter: $PRD_VALIDATE_FILTER_FILE" "Run from template or embedded repo root"

  # SUPPORTED_MODES_JSON and CREATED_AC_REGEX are set by ralph.sh before sourcing this file
  # shellcheck disable=SC2153
  if ! validate_prd_with_jq "$PRD_FILE" "$PRD_SCHEMA_FILE" "$PRD_VALIDATE_FILTER_FILE" \
    "$SUPPORTED_MODES_JSON" "$CREATED_AC_REGEX"; then
    (emit_prd_validation_diagnostic "$PRD_FILE" "$PRD_SCHEMA_FILE" "$PRD_VALIDATE_FILTER_FILE" \
      "$SUPPORTED_MODES_JSON" "$CREATED_AC_REGEX") || true
    fail "$RALPH_EXIT_PRD" "Invalid prd.json structure or story constraints" "Run ./ralph.sh --validate-prd for schema check, or check prd.schema.json and prd.validate.jq"
  fi

  validate_prd_text_hygiene
}

maybe_auto_archive_on_project_change() {
  local track_file current_project previous_project archive_script

  if [[ "${MODE:-}" != "fixing" ]]; then
    log_event "INFO auto_archive_skipped mode=${MODE:-unset}"
    return
  fi

  track_file="$STATE_DIR/.last-project"
  current_project="$(jq -r '.project // ""' "$PRD_FILE" 2>/dev/null || true)"
  if [[ -z "$current_project" || "$current_project" == "null" ]]; then
    current_project="unknown-project"
  fi
  if [[ -f "$track_file" ]]; then
    previous_project="$(cat "$track_file" 2>/dev/null || true)"
  else
    previous_project=""
  fi

  if is_true "$AUTO_ARCHIVE_ON_PROJECT_CHANGE" &&
    [[ -n "$previous_project" ]] &&
    [[ "$previous_project" != "$current_project" ]]; then
    archive_script="$SCRIPT_DIR/scripts/archive_run_state.sh"
    if [[ ! -x "$archive_script" ]]; then
      fail "Auto archive enabled but missing executable script: $archive_script"
    fi
    if "$archive_script" \
      --source-root "$SCRIPT_DIR" \
      --label "$previous_project" \
      --reason "auto-archive on project change ($previous_project -> $current_project)" \
      >/dev/null 2>&1; then
      log_event "INFO auto_archive_on_project_change previous=$previous_project current=$current_project"
    else
      fail "Auto archive on project change failed (previous=$previous_project current=$current_project)"
    fi
  fi

  printf '%s\n' "$current_project" >"$track_file"
}

extract_prd_branch_target() {
  jq -r '
    if (.branch_name | type) == "string" and (.branch_name | length) > 0 then
      .branch_name
    elif (.branchName | type) == "string" and (.branchName | length) > 0 then
      .branchName
    else
      ""
    end
  ' "$PRD_FILE" 2>/dev/null || true
}

resolve_default_base_branch() {
  local candidate
  for candidate in main master; do
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done

  candidate="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "$candidate" && "$candidate" != "HEAD" ]]; then
    printf '%s' "$candidate"
    return
  fi

  printf ''
}

maybe_sync_branch_from_prd() {
  local target_branch current_branch base_branch

  if [[ "${MODE:-}" != "fixing" ]]; then
    log_event "INFO branch_sync_skipped mode=${MODE:-unset}"
    return
  fi

  if ! is_true "$SYNC_BRANCH_FROM_PRD"; then
    return
  fi
  command -v git >/dev/null 2>&1 || fail "Branch sync requested but git is not available"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Branch sync requested outside git worktree"

  target_branch="$(extract_prd_branch_target)"
  if [[ -z "$target_branch" ]]; then
    log_event "INFO branch_sync_requested_but_no_prd_branch"
    return
  fi
  # Reject unsafe branch names (path traversal, option injection, or newlines).
  case "$target_branch" in
  *".."* | *$'\n'*) fail "Unsafe branch name from PRD (no '..' or newlines)" ;;
  "") fail "Empty branch name from PRD" ;;
  esac
  [[ "$target_branch" != -* ]] || fail "Branch name must not start with '-'"

  current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$current_branch" == "$target_branch" ]]; then
    log_event "INFO branch_sync_already_on_target branch=$target_branch"
    return
  fi

  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$target_branch"; then
    git -C "$REPO_ROOT" checkout "$target_branch" >/dev/null 2>&1 || fail "Failed to checkout branch from PRD: $target_branch"
    log_event "INFO branch_sync_checked_out_existing branch=$target_branch"
    return
  fi

  base_branch="$(resolve_default_base_branch)"
  if [[ -n "$base_branch" && "$base_branch" != "$target_branch" ]]; then
    git -C "$REPO_ROOT" checkout -b "$target_branch" "$base_branch" >/dev/null 2>&1 || fail "Failed to create branch $target_branch from $base_branch"
    log_event "INFO branch_sync_created branch=$target_branch base=$base_branch"
  else
    git -C "$REPO_ROOT" checkout -b "$target_branch" >/dev/null 2>&1 || fail "Failed to create branch from PRD: $target_branch"
    log_event "INFO branch_sync_created branch=$target_branch"
  fi
}

load_default_report_dir() {
  DEFAULT_REPORT_DIR="$(jq -r '.defaults.report_dir // ""' "$PRD_FILE" 2>/dev/null || true)"
  if [[ "$DEFAULT_REPORT_DIR" == "null" ]]; then
    DEFAULT_REPORT_DIR=""
  fi
  DEFAULT_REPORT_DIR="${DEFAULT_REPORT_DIR#./}"
  DEFAULT_REPORT_DIR="${DEFAULT_REPORT_DIR%/}"
}

# shellcheck source=lib/ralph/lock.sh
source "$_ralph_lib/lock.sh"
