# shellcheck shell=bash
# shellcheck disable=SC2153
# =============================================================================
# REPO LIST BUILDING
# =============================================================================

REPO_URLS=()
REPO_PATHS=()
CONFIG_HAS_REPOS=false

if [[ -n "$CONFIG_FILE" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log_error "Config file not found: $CONFIG_FILE"
    exit 1
  fi
  if ! validate_config_json "$CONFIG_FILE"; then
    log_error "Config file validation failed: $CONFIG_FILE"
    exit 1
  fi
  load_targets_from_config "$CONFIG_FILE"
  load_repos_from_config "$CONFIG_FILE"
fi

if [[ -n "$REPOS_FILE" ]]; then
  if [[ "$CONFIG_HAS_REPOS" == true ]]; then
    log_warn "--repos-file ignored because --config contains repos."
  else
    if [[ ! -f "$REPOS_FILE" ]]; then
      log_error "Repos file not found: $REPOS_FILE"
      exit 1
    fi
    load_repos_from_file "$REPOS_FILE"
  fi
fi

if [[ ${#REPO_ARGS[@]} -gt 0 && "$CONFIG_HAS_REPOS" != true ]]; then
  if [[ $((${#REPO_ARGS[@]} % 2)) -ne 0 ]]; then
    log_error "Repo list must be pairs of <url> <path> (got ${#REPO_ARGS[@]} args)"
    usage
    exit 1
  fi
  i=0
  while [[ $i -lt ${#REPO_ARGS[@]} ]]; do
    REPO_URLS+=("${REPO_ARGS[$i]}")
    REPO_PATHS+=("${REPO_ARGS[$((i + 1))]}")
    i=$((i + 2))
  done
fi

# =============================================================================
# VALIDATION
# =============================================================================

if [[ ${#REPO_URLS[@]} -eq 0 ]]; then
  log_error "No repos specified. Use <url> <path>, --repos-file, or --config with repos array."
  usage
  exit 1
fi

require_command git python3
if [[ "$VALIDATE_ONLY" == false ]]; then
  if ! command -v git-filter-repo >/dev/null 2>&1; then
    log_error "git-filter-repo is required. Install with: brew install git-filter-repo"
    exit 1
  fi
fi
if [[ -n "$BACKUP_REMOTE" && ! "$BACKUP_REMOTE" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  log_error "--backup-remote must be a valid remote name (letters, numbers, dots, hyphens, underscores only)"
  exit 1
fi
resolve_targets || {
  log_error "Target configuration is invalid."
  exit 1
}

# =============================================================================
# PROCESSING
# =============================================================================

num_repos=${#REPO_URLS[@]}
_BACKUP_COUNTER=0
fail_count=0
success_count=0
FAILED_REPO_URLS=()
FAILED_REPO_PATHS=()

for ((i = 0; i < num_repos; i++)); do
  [[ "$QUIET" == false ]] && echo "========== Repo $((i + 1))/$num_repos =========="
  set +e
  process_one_repo "${REPO_URLS[$i]}" "${REPO_PATHS[$i]}"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    FAILED_REPO_URLS+=("${REPO_URLS[$i]}")
    FAILED_REPO_PATHS+=("${REPO_PATHS[$i]}")
    [[ "$QUIET" == false ]] && echo "Failed for ${REPO_URLS[$i]} (${REPO_PATHS[$i]}); continuing with next."
    [[ "$QUIET" == true ]] && log_error "${REPO_URLS[$i]} — failed"
    fail_count=$((fail_count + 1))
  else
    success_count=$((success_count + 1))
  fi
done

# --- Summary ---

if [[ $num_repos -eq 1 && $fail_count -gt 0 ]]; then
  echo "Done (failed)."
elif [[ $num_repos -gt 1 ]]; then
  echo "Done. $success_count/$num_repos succeeded, $fail_count failed."
else
  echo "Done."
fi
if [[ $fail_count -gt 0 && "$QUIET" == false ]]; then
  echo -n "Failed repos:"
  for ((i = 0; i < fail_count; i++)); do
    echo -n " ${FAILED_REPO_URLS[$i]} (${FAILED_REPO_PATHS[$i]})"
  done
  echo
fi

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
