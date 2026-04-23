# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154
# =============================================================================
# LOGGING HELPERS
# =============================================================================

log_ok() { if [[ "$use_color" == true ]]; then echo -e "\033[32m[ok]\033[0m $*"; else echo "[ok] $*"; fi; }
log_warn() { if [[ "$use_color" == true ]]; then echo -e "\033[33m[warn]\033[0m $*" >&2; else echo "[warn] $*" >&2; fi; }
log_error() { if [[ "$use_color" == true ]]; then echo -e "\033[31m[error]\033[0m $*" >&2; else echo "[error] $*" >&2; fi; }
log_info() { [[ "$QUIET" == false ]] && echo "[info] $*"; }
log_skip() { echo "[skip] $*"; }

# =============================================================================
# CONFIG & REPO LOADING
# =============================================================================

# Validate JSON config structure. Returns 0 if valid (or python3 unavailable), 1 if invalid.
# Uses pure Python stdlib — no external dependencies.
validate_config_json() {
  local config_file="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding='utf-8'))
except (json.JSONDecodeError, FileNotFoundError) as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
if not isinstance(data, dict):
    print('ERROR: Config must be a JSON object', file=sys.stderr)
    sys.exit(1)
if 'defaults' in data:
    d = data['defaults']
    if not isinstance(d, dict):
        print('ERROR: defaults must be an object', file=sys.stderr)
        sys.exit(1)
    for key in ('dryRun', 'noPush', 'forcePush'):
        if key in d and not isinstance(d[key], bool):
            print(f'ERROR: defaults.{key} must be a boolean', file=sys.stderr)
            sys.exit(1)
    if 'backupRemote' in d:
        br = d['backupRemote']
        if not isinstance(br, str):
            print('ERROR: defaults.backupRemote must be a string', file=sys.stderr)
            sys.exit(1)
        import re as _re
        if br and not _re.match(r'^[a-zA-Z0-9_.-]+$', br):
            print('ERROR: defaults.backupRemote must contain only letters, numbers, dots, hyphens, underscores', file=sys.stderr)
            sys.exit(1)
if 'targets' in data:
    targets = data['targets']
    if not isinstance(targets, list) or not targets:
        print('ERROR: targets must be a non-empty array', file=sys.stderr)
        sys.exit(1)
    for i, target in enumerate(targets):
        if not isinstance(target, dict):
            print(f'ERROR: targets[{i}] must be an object', file=sys.stderr)
            sys.exit(1)
        if 'name' not in target or not isinstance(target['name'], str) or not target['name'].strip():
            print(f'ERROR: targets[{i}].name must be a non-empty string', file=sys.stderr)
            sys.exit(1)
        if 'email' not in target or not isinstance(target['email'], str) or not __import__('re').match(r'^[^<>\s]+@[^<>\s]+$', target['email']):
            print(f'ERROR: targets[{i}].email must be a simple email address', file=sys.stderr)
            sys.exit(1)
if 'repos' in data:
    repos = data['repos']
    if not isinstance(repos, list):
        print('ERROR: repos must be an array', file=sys.stderr)
        sys.exit(1)
    for i, repo in enumerate(repos):
        if not isinstance(repo, dict):
            print(f'ERROR: repos[{i}] must be an object', file=sys.stderr)
            sys.exit(1)
        if 'url' not in repo or not isinstance(repo['url'], str) or not repo['url']:
            print(f'ERROR: repos[{i}].url must be a non-empty string', file=sys.stderr)
            sys.exit(1)
        if 'path' not in repo or not isinstance(repo['path'], str) or not repo['path']:
            print(f'ERROR: repos[{i}].path must be a non-empty string', file=sys.stderr)
            sys.exit(1)
" "$config_file"
}

apply_config_defaults() {
  local config_file="$1"
  [[ -z "$config_file" || ! -f "$config_file" ]] && return 0
  local tmp
  create_temp_file
  tmp=$CREATED_TEMP_FILE
  _json_extract "$config_file" "defaults" >"$tmp" 2>/dev/null || {
    log_warn "Failed to parse config defaults from $config_file (is it valid JSON?)"
    return 0
  }
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local key="${line%%=*}"
    local val="${line#*=}"
    case "$key" in
    DRY_RUN) [[ "$val" == true || "$val" == false ]] && DRY_RUN="$val" ;;
    NO_PUSH) [[ "$val" == true || "$val" == false ]] && NO_PUSH="$val" ;;
    FORCE_PUSH) [[ "$val" == true || "$val" == false ]] && FORCE_PUSH="$val" ;;
    BACKUP_REMOTE) [[ -n "$val" ]] && BACKUP_REMOTE="$val" ;;
    esac
  done <"$tmp"
  # Temp file cleanup handled by EXIT trap; no explicit removal needed.
}

load_repos_from_json_file() {
  local json_file="$1"
  local mode="${2:-repos}"
  local tmp
  create_temp_file
  tmp=$CREATED_TEMP_FILE
  _json_extract "$json_file" "$mode" >"$tmp" 2>/dev/null || return 1
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" != *$'\t'* ]] && continue
    REPO_URLS+=("${line%%$'\t'*}")
    REPO_PATHS+=("${line#*$'\t'}")
  done <"$tmp"
  return 0
}

load_repos_from_config() {
  local config_file="$1"
  [[ -z "$config_file" || ! -f "$config_file" ]] && return 0
  if load_repos_from_json_file "$config_file" "repos"; then
    if [[ ${#REPO_URLS[@]} -gt 0 ]]; then
      CONFIG_HAS_REPOS=true
    fi
    return 0
  else
    log_error "Failed to load config (need python3 and valid JSON): $config_file"
    exit 1
  fi
}

load_targets_from_config() {
  local config_file="$1"
  [[ -z "$config_file" || ! -f "$config_file" ]] && return 0
  local tmp
  create_temp_file
  tmp=$CREATED_TEMP_FILE
  _json_extract "$config_file" "targets" >"$tmp" 2>/dev/null || return 1
  local targets_json="[]"
  targets_json="$(python3 -c "
import json, sys
targets = []
with open(sys.argv[1], encoding='utf-8') as handle:
    for line in handle:
        line = line.rstrip('\n')
        if not line or '\t' not in line:
            continue
        name, email = line.split('\t', 1)
        if not name or not email:
            continue
        targets.append({'name': name, 'email': email})
print(json.dumps(targets, separators=(',', ':')))
" "$tmp")" || return 1
  if [[ "$targets_json" != "[]" ]]; then
    validate_targets_json "$targets_json" || return 1
    CONFIG_TARGETS_JSON="$VALIDATED_TARGETS_JSON"
  fi
}

load_repos_from_file() {
  local repos_file="$1"
  [[ -z "$repos_file" || ! -f "$repos_file" ]] && return 0
  # Detect whether the file looks like JSON (first non-whitespace char is { or [).
  local first_char
  first_char=$(python3 -c "
import sys
with open(sys.argv[1], encoding='utf-8') as f:
    for line in f:
        s = line.lstrip()
        if s:
            print(s[0])
            break
" "$repos_file" 2>/dev/null || true)

  if python3 -c "import json, sys; d = json.load(open(sys.argv[1], encoding='utf-8')); exit(0 if isinstance(d, list) else 1)" "$repos_file" 2>/dev/null; then
    load_repos_from_json_file "$repos_file" "root" || true
  elif [[ "$first_char" == "{" || "$first_char" == "[" ]]; then
    log_error "Repos file appears to be JSON but failed to parse (must be a JSON array of {url, path} objects): $repos_file"
    exit 1
  else
    # Plain-text format: first token is URL (must not contain spaces), rest of line is path
    while IFS= read -r line; do
      # Strip leading/trailing whitespace and skip full-line comments.
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      local url="${line%% *}"
      local path="${line#* }"
      path="${path#"${path%%[![:space:]]*}"}"
      path="${path%"${path##*[![:space:]]}"}"
      if [[ -z "$path" || "$path" == "$url" ]]; then
        log_warn "Repos file line must be 'url path'; path missing: $line"
        continue
      fi
      REPO_URLS+=("$url")
      REPO_PATHS+=("$path")
    done <"$repos_file"
  fi
}

# =============================================================================
# PROCESS ONE REPO
# =============================================================================

# Validates URL and path; sets USERNAME, REPONAME, CANONICAL_URL, CURRENT_BRANCH.
# If VALIDATE_ONLY, prints validation message and returns 0. Returns 1 on validation failure.
validate_repo_input() {
  local GITHUB_URL="$1"
  local LOCAL_REPO_PATH="$2"
  local status_porcelain upstream_ref ahead_behind ahead_count behind_count
  if ! parse_github_url "$GITHUB_URL"; then
    log_error "GitHub URL must be https://github.com/<user>/<repo> or git@github.com:<user>/<repo> (got: $GITHUB_URL)"
    return 1
  fi
  USERNAME="$PARSED_USERNAME"
  REPONAME="$PARSED_REPONAME"
  CANONICAL_URL="$PARSED_CANONICAL_URL"

  if [[ ! "$USERNAME" =~ ^[a-zA-Z0-9_.-]+$ || ! "$REPONAME" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    log_error "Username and repo name must contain only letters, numbers, dots, hyphens, and underscores."
    return 1
  fi

  if [[ "$LOCAL_REPO_PATH" != /* ]]; then
    log_error "Local repo path must be absolute: $LOCAL_REPO_PATH"
    return 1
  fi

  if [[ ! -d "$LOCAL_REPO_PATH" ]]; then
    log_error "Local repo path does not exist: $LOCAL_REPO_PATH"
    return 1
  fi

  if [[ "$(basename "$LOCAL_REPO_PATH")" != "$REPONAME" ]]; then
    log_warn "Repo name from URL ('$REPONAME') does not match local dir basename ('$(basename "$LOCAL_REPO_PATH")'). Proceeding anyway."
  fi

  if ! git -C "$LOCAL_REPO_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log_error "Path is not a git repository: $LOCAL_REPO_PATH"
    return 1
  fi

  if [[ "$NO_PUSH" == false && "$DRY_RUN" == false ]]; then
    local has_remote=0
    local remote_name
    while IFS= read -r remote_name; do
      [[ -n "$remote_name" ]] && {
        has_remote=1
        break
      }
    done < <(git -C "$LOCAL_REPO_PATH" remote 2>/dev/null || true)
    if [[ $has_remote -eq 0 ]]; then
      log_error "Repository has no remotes configured; add a remote or run with --no-push: $LOCAL_REPO_PATH"
      return 1
    fi
  fi

  CURRENT_BRANCH="$(git -C "$LOCAL_REPO_PATH" symbolic-ref --quiet --short HEAD || true)"
  if [[ -z "$CURRENT_BRANCH" ]]; then
    log_error "Repository is in detached HEAD state. Check out a branch first (e.g. main or master): $LOCAL_REPO_PATH"
    return 1
  fi

  if [[ "$VALIDATE_ONLY" == false && "$DRY_RUN" == false ]]; then
    status_porcelain="$(git -C "$LOCAL_REPO_PATH" status --porcelain 2>/dev/null || true)"
    if [[ -n "$status_porcelain" ]]; then
      log_error "Repository worktree must be clean before rewrite: $LOCAL_REPO_PATH"
      return 1
    fi
  fi

  if [[ "$NO_PUSH" == false && "$DRY_RUN" == false ]]; then
    upstream_ref="$(git -C "$LOCAL_REPO_PATH" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
    if [[ -z "$upstream_ref" ]]; then
      log_error "Current branch must track an upstream before push rewrite: $LOCAL_REPO_PATH"
      return 1
    fi
    ahead_behind="$(git -C "$LOCAL_REPO_PATH" rev-list --left-right --count "HEAD...$upstream_ref" 2>/dev/null || true)"
    ahead_count="${ahead_behind%%$'\t'*}"
    behind_count="${ahead_behind#*$'\t'}"
    if [[ ! "$ahead_count" =~ ^[0-9]+$ || ! "$behind_count" =~ ^[0-9]+$ ]]; then
      log_error "Could not determine ahead/behind status for upstream $upstream_ref"
      return 1
    fi
    if [[ "$ahead_count" -ne 0 || "$behind_count" -ne 0 ]]; then
      log_error "Branch must be in sync with upstream before push rewrite (ahead=$ahead_count behind=$behind_count): $LOCAL_REPO_PATH"
      return 1
    fi
  fi

  if [[ "$VALIDATE_ONLY" == true ]]; then
    if [[ "$QUIET" == true ]]; then
      log_ok "$USERNAME/$REPONAME — validation passed"
    else
      echo "---"
      echo "Validated: $USERNAME/$REPONAME"
      echo "  url:    $CANONICAL_URL"
      echo "  local:  $LOCAL_REPO_PATH"
      echo "  branch: $CURRENT_BRANCH"
      echo "  targets: $TARGET_SUMMARY"
      log_ok "All checks passed (validate-only; no changes made)."
    fi
    return 0
  fi
  return 0
}

# Backs up remotes, optionally pushes to BACKUP_REMOTE, creates backup branch, runs filter-repo, restores remotes.
# Sets BACKUP_BRANCH, BACKUP_REMOTES_TMP. Returns 1 if filter-repo failed.
do_rewrite_and_restore_remotes() {
  local LOCAL_REPO_PATH="$1"
  # Include a counter to prevent name collisions when processing the same repo
  # twice in a batch within the same second.
  _BACKUP_COUNTER=$((_BACKUP_COUNTER + 1))
  BACKUP_BRANCH="${BACKUP_BRANCH_PREFIX}$(date +%Y%m%d-%H%M%S)-$$-${_BACKUP_COUNTER}"

  if [[ "$QUIET" == false ]]; then
    echo "---"
    echo "Processing: $USERNAME/$REPONAME"
    echo "  url:        $CANONICAL_URL"
    echo "  local:      $LOCAL_REPO_PATH"
    echo "  branch:     $CURRENT_BRANCH"
    echo "  targets:    $TARGET_SUMMARY"
    echo "  dry-run:    $DRY_RUN"
    echo "  no-push:    $NO_PUSH"
    echo "  force-push: $FORCE_PUSH"
  fi

  create_temp_file
  BACKUP_REMOTES_TMP=$CREATED_TEMP_FILE
  # Back up remotes before filter-repo (which removes all remotes).
  git -C "$LOCAL_REPO_PATH" remote -v | awk '{gsub(/[()]/, "", $3); print $1"\t"$3"\t"$2}' >"$BACKUP_REMOTES_TMP" 2>/dev/null || true
  if [[ ! -s "$BACKUP_REMOTES_TMP" && "$NO_PUSH" == false && "$DRY_RUN" == false ]]; then
    log_warn "No remotes found to back up; remote restoration after filter-repo will be skipped."
  fi

  if [[ -n "${BACKUP_REMOTE:-}" && "$DRY_RUN" == false && "$NO_PUSH" == false ]]; then
    run_cmd git -C "$LOCAL_REPO_PATH" push "$BACKUP_REMOTE" "$CURRENT_BRANCH" || return 1
  fi

  run_cmd git -C "$LOCAL_REPO_PATH" branch "$BACKUP_BRANCH" || return 1

  local filter_err=0
  run_cmd git -C "$LOCAL_REPO_PATH" filter-repo --refs "$CURRENT_BRANCH" --force --message-callback "$MESSAGE_CALLBACK" || filter_err=1

  if [[ "$DRY_RUN" == false ]]; then
    restore_remotes_from_backup "$LOCAL_REPO_PATH" "$BACKUP_REMOTES_TMP"
  else
    log_info "Would restore remotes from backup"
  fi

  if [[ $filter_err -ne 0 ]]; then
    log_error "git-filter-repo failed during execution! Remotes have been restored."
    return 1
  fi
  return 0
}

# Resolves TARGET_REMOTE from BACKUP_REMOTES_TMP (file is read again; small file, separate concern) and pushes branch and tags.
do_push_phase() {
  local LOCAL_REPO_PATH="$1"
  local resolve_rc=0
  TARGET_REMOTE="$(resolve_target_remote "$BACKUP_REMOTES_TMP" "$CANONICAL_URL")" || resolve_rc=$?

  if [[ $resolve_rc -ne 0 || -z "$TARGET_REMOTE" ]]; then
    if [[ "$DRY_RUN" == false ]]; then
      log_error "No usable remotes available for push."
      return 1
    fi
    # In dry-run mode, allow command preview even if no remote can be resolved.
    TARGET_REMOTE="origin"
  fi

  push_branch_and_tags "$LOCAL_REPO_PATH" "$TARGET_REMOTE" "$CURRENT_BRANCH" "$FORCE_PUSH" || return 1
  return 0
}

# Deletes remote backup branches, local backup branch, runs check_target_trailers, fetch --prune.
do_cleanup_and_verify() {
  local LOCAL_REPO_PATH="$1"
  if [[ "$DRY_RUN" == false ]]; then
    # Delete only backup branches on the selected push remote. This avoids
    # ambiguous parsing when remote names contain '/' (valid in git).
    if [[ -n "${TARGET_REMOTE:-}" ]]; then
      local fullref br
      while IFS= read -r fullref; do
        [[ -z "$fullref" ]] && continue
        br="${fullref#refs/remotes/"$TARGET_REMOTE"/}"
        [[ -z "$br" || "$br" == "$fullref" ]] && continue
        run_cmd git -C "$LOCAL_REPO_PATH" push "$TARGET_REMOTE" --delete "$br" || true
      done < <(git -C "$LOCAL_REPO_PATH" for-each-ref --format='%(refname)' "refs/remotes/${TARGET_REMOTE}/${BACKUP_BRANCH_PREFIX}*" 2>/dev/null || true)
    fi

    run_cmd git -C "$LOCAL_REPO_PATH" branch -D "$BACKUP_BRANCH" || true

    check_target_trailers "$LOCAL_REPO_PATH"

    if [[ -n "${TARGET_REMOTE:-}" ]]; then
      run_cmd git -C "$LOCAL_REPO_PATH" fetch --prune "$TARGET_REMOTE" || true
    fi
    if [[ "$VERBOSE" == true ]]; then
      run_cmd git -C "$LOCAL_REPO_PATH" branch -a || true
    fi
  else
    log_info "Skipped network/git mutations and verification (dry-run)."
  fi
  return 0
}

process_one_repo() {
  local GITHUB_URL="$1"
  local LOCAL_REPO_PATH="$2"

  validate_repo_input "$GITHUB_URL" "$LOCAL_REPO_PATH" || return 1
  [[ "$VALIDATE_ONLY" == true ]] && return 0

  do_rewrite_and_restore_remotes "$LOCAL_REPO_PATH" || return 1

  if [[ "$NO_PUSH" == true ]]; then
    log_info "Skipping remote and push; history rewritten locally only."
    if [[ "$DRY_RUN" == false ]]; then
      run_cmd git -C "$LOCAL_REPO_PATH" branch -D "$BACKUP_BRANCH" || true
    fi
    [[ "$QUIET" == true ]] && log_ok "$USERNAME/$REPONAME — rewritten locally"
    return 0
  fi

  if ! do_push_phase "$LOCAL_REPO_PATH"; then
    if rollback_local_rewrite "$LOCAL_REPO_PATH" "$BACKUP_BRANCH"; then
      log_warn "Push phase failed after local rewrite; restored local branch from $BACKUP_BRANCH"
    else
      log_error "Push phase failed after local rewrite; manual recovery may be required (backup branch: $BACKUP_BRANCH)"
    fi
    return 1
  fi
  do_cleanup_and_verify "$LOCAL_REPO_PATH"

  [[ "$QUIET" == true ]] && log_ok "$USERNAME/$REPONAME — done"
  return 0
}

# =============================================================================
# CLI PARSING
# =============================================================================

# Defaults (overridden by --config, then by CLI)
DRY_RUN=false
NO_PUSH=true
FORCE_PUSH=true
VALIDATE_ONLY=false
QUIET=false
VERBOSE=true
CONFIG_FILE=""
REPOS_FILE=""
BACKUP_REMOTE=""
CONFIG_TARGETS_JSON=""
TARGET_ARGS=()
REPO_ARGS=()

# (1) Two-pass CLI parsing: first scan for --config to load defaults,
# then parse all options. This lets config defaults be overridden by CLI flags
# regardless of argument order (e.g., "--dry-run --config f.json" works).
args=("$@")
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "--config" && $((i + 1)) -lt ${#args[@]} ]]; then
    CONFIG_FILE="${args[$((i + 1))]}"
  fi
done

# (2) Apply config defaults; CLI will override below
apply_config_defaults "$CONFIG_FILE"

# (3) Parse CLI options (overrides config)
while [[ $# -gt 0 ]]; do
  case "$1" in
  --help | -h)
    usage
    exit 0
    ;;
  --version)
    echo "$PROGRAM_NAME $VERSION"
    exit 0
    ;;
  --dry-run)
    DRY_RUN=true
    shift
    ;;
  --push)
    NO_PUSH=false
    shift
    ;;
  --no-push)
    NO_PUSH=true
    shift
    ;;
  --force-push)
    FORCE_PUSH=true
    shift
    ;;
  --no-force-push)
    FORCE_PUSH=false
    shift
    ;;
  --validate-only)
    VALIDATE_ONLY=true
    shift
    ;;
  --quiet | -q)
    QUIET=true
    VERBOSE=false
    shift
    ;;
  --verbose | -v)
    VERBOSE=true
    QUIET=false
    shift
    ;;
  --target)
    [[ $# -lt 2 ]] && {
      log_error "--target requires <Name <email>>"
      usage
      exit 1
    }
    TARGET_ARGS+=("$2")
    shift 2
    ;;
  --config)
    [[ $# -lt 2 ]] && {
      log_error "--config requires <file>"
      usage
      exit 1
    }
    CONFIG_FILE="$2"
    shift 2
    ;;
  --repos-file)
    [[ $# -lt 2 ]] && {
      log_error "--repos-file requires <file>"
      usage
      exit 1
    }
    REPOS_FILE="$2"
    shift 2
    ;;
  --backup-remote)
    [[ $# -lt 2 ]] && {
      log_error "--backup-remote requires <remote name>"
      usage
      exit 1
    }
    BACKUP_REMOTE="$2"
    shift 2
    ;;
  -*)
    log_error "Unsupported option '$1'"
    usage
    exit 1
    ;;
  *)
    REPO_ARGS+=("$1")
    shift
    ;;
  esac
done
