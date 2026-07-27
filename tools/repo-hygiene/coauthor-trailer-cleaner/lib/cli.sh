# shellcheck shell=bash
# shellcheck disable=SC2034 # Globals are consumed by sibling sourced modules.
# Parses cleaner arguments and dispatches repositories while keeping defaults and validation centralized.

reset_cli_state() {
  DRY_RUN=false
  NO_PUSH=true
  VALIDATE_ONLY=false
  QUIET=false
  VERBOSE=true
  CONFIG_FILE=""
  REPOS_FILE=""
  BACKUP_REMOTE=""
  CONFIG_TARGETS_JSON=""
  TARGET_ARGS=()
  REPO_ARGS=()
  REPO_URLS=()
  REPO_PATHS=()
}

find_config_argument() {
  local -a arguments=("$@")
  local index
  for index in "${!arguments[@]}"; do
    if [[ "${arguments[$index]}" == "--config" && $((index + 1)) -lt ${#arguments[@]} ]]; then
      CONFIG_FILE="${arguments[$((index + 1))]}"
    fi
  done
}

parse_cli_args() {
  find_config_argument "$@"
  if [[ -n "$CONFIG_FILE" ]]; then
    [[ -f "$CONFIG_FILE" ]] || {
      log_error "Config file not found: $CONFIG_FILE"
      return 1
    }
    validate_config_json "$CONFIG_FILE" || return 1
    apply_config_defaults "$CONFIG_FILE"
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --help | -h) usage; return 2 ;;
    --version) printf '%s %s\n' "$PROGRAM_NAME" "$VERSION"; return 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --push) NO_PUSH=false; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    --validate-only) VALIDATE_ONLY=true; shift ;;
    --quiet | -q) QUIET=true; VERBOSE=false; shift ;;
    --verbose | -v) VERBOSE=true; QUIET=false; shift ;;
    --target)
      [[ $# -ge 2 ]] || { log_error "--target requires a value"; return 1; }
      TARGET_ARGS+=("$2"); shift 2
      ;;
    --config)
      [[ $# -ge 2 ]] || { log_error "--config requires a file"; return 1; }
      CONFIG_FILE="$2"; shift 2
      ;;
    --repos-file)
      [[ $# -ge 2 ]] || { log_error "--repos-file requires a file"; return 1; }
      REPOS_FILE="$2"; shift 2
      ;;
    --backup-remote)
      [[ $# -ge 2 ]] || { log_error "--backup-remote requires a remote"; return 1; }
      BACKUP_REMOTE="$2"; shift 2
      ;;
    -*)
      log_error "Unsupported option '$1'"
      return 1
      ;;
    *)
      REPO_ARGS+=("$1"); shift
      ;;
    esac
  done
}

build_repo_list() {
  local index
  if [[ -n "$CONFIG_FILE" ]]; then
    load_targets_from_config "$CONFIG_FILE" || return 1
    load_repos_from_json_file "$CONFIG_FILE" repos || return 1
  fi
  if [[ -n "$REPOS_FILE" && ${#REPO_URLS[@]} -eq 0 ]]; then
    [[ -f "$REPOS_FILE" ]] || {
      log_error "Repos file not found: $REPOS_FILE"
      return 1
    }
    load_repos_from_file "$REPOS_FILE" || return 1
  fi
  if [[ ${#REPO_ARGS[@]} -gt 0 && ${#REPO_URLS[@]} -eq 0 ]]; then
    [[ $((${#REPO_ARGS[@]} % 2)) -eq 0 ]] || {
      log_error "Repo list must contain <url> <path> pairs."
      return 1
    }
    for ((index = 0; index < ${#REPO_ARGS[@]}; index += 2)); do
      REPO_URLS+=("${REPO_ARGS[$index]}")
      REPO_PATHS+=("${REPO_ARGS[$((index + 1))]}")
    done
  fi
  [[ ${#REPO_URLS[@]} -gt 0 ]] || {
    log_error "No repos specified."
    return 1
  }
}

validate_runtime() {
  require_command git "$PYTHON_BIN" || return 1
  if [[ "$VALIDATE_ONLY" == false ]]; then
    require_command git-filter-repo || return 1
  fi
  if [[ -n "$BACKUP_REMOTE" && ! "$BACKUP_REMOTE" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    log_error "--backup-remote must be a valid remote name."
    return 1
  fi
  resolve_targets || {
    log_error "Target configuration is invalid."
    return 1
  }
}

process_repositories() {
  local total="${#REPO_URLS[@]}"
  local failures=0
  local index
  for ((index = 0; index < total; index++)); do
    [[ "$QUIET" == false ]] && printf '========== Repo %s/%s ==========\n' "$((index + 1))" "$total"
    if ! process_one_repo "${REPO_URLS[$index]}" "${REPO_PATHS[$index]}"; then
      failures=$((failures + 1))
      log_error "${REPO_URLS[$index]}: failed"
    fi
  done
  if [[ $failures -gt 0 ]]; then
    printf 'Done. %s/%s failed.\n' "$failures" "$total"
    return 1
  fi
  printf 'Done.\n'
}

coauthor_cleaner_main() {
  local parse_rc=0
  reset_cli_state
  parse_cli_args "$@" || parse_rc=$?
  [[ $parse_rc -eq 2 ]] && return 0
  [[ $parse_rc -eq 0 ]] || { usage; return 1; }
  build_repo_list || { usage; return 1; }
  validate_runtime || return 1
  process_repositories
}
