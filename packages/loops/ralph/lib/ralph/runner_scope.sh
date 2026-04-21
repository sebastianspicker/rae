# shellcheck shell=bash
# Fixing state capture and scope enforcement.
# Sourced by runner.sh; expects core.sh, config.sh, prd.sh globals.

file_signature_or_missing() {
  local path="$1"
  local signature
  if [[ -f "$path" ]]; then
    if ! signature="$(file_state_signature "$path")"; then
      fail "Could not read file metadata for: $path"
    fi
    printf '%s' "$signature"
  else
    printf '__missing__'
  fi
}

capture_worktree_state() {
  local out_file="$1"
  local method="full"

  if should_use_git_state_fast_path; then
    if capture_worktree_state_git "$out_file"; then
      method="git"
    else
      capture_worktree_state_full "$out_file"
      method="full"
    fi
  else
    capture_worktree_state_full "$out_file"
    method="full"
  fi

  if [[ "$MODE" == "fixing" && "$FIXING_STATE_METHOD_LOGGED" != "true" ]]; then
    log_event "INFO fixing_state_method=$method requested=$FIXING_STATE_METHOD"
    FIXING_STATE_METHOD_LOGGED="true"
  fi
}

# Shared loop body: iterate null-delimited entries, compute signatures, write TSV state file.
_capture_worktree_from_entries() {
  local out_file="$1" entries_file="$2"
  local tmp_unsorted rel abs_path signature

  tmp_unsorted="$(mktemp "$STATE_DIR/.state-raw.XXXXXX")"
  register_tmp "$tmp_unsorted"
  : > "$tmp_unsorted"

  while IFS= read -r -d '' rel; do
    [[ -n "$rel" ]] || continue
    rel="${rel#./}"
    is_runner_internal_path "$rel" && continue
    abs_path="$REPO_ROOT/$rel"
    [[ -e "$abs_path" || -L "$abs_path" ]] || continue
    if ! signature="$(file_state_signature "$abs_path")"; then
      fail "Could not read file metadata for: $abs_path"
    fi
    printf '%s\v%s\034' "$rel" "$signature" >> "$tmp_unsorted"
  done < "$entries_file"

  mv "$tmp_unsorted" "$out_file"
}

capture_worktree_state_full() {
  local out_file="$1"
  local entries_file

  : > "$out_file"
  entries_file="$(mktemp "$STATE_DIR/.state-entries.full.XXXXXX")"
  register_tmp "$entries_file"

  (
    cd "$REPO_ROOT" || exit 1
    find . \( -path './.git' -o -path './.git/*' \) -prune -o \( -type f -o -type l \) -print0
  ) > "$entries_file" || fail "Could not enumerate repository files for state snapshot"

  _capture_worktree_from_entries "$out_file" "$entries_file"
}

capture_worktree_state_git() {
  local out_file="$1"
  local entries_file

  : > "$out_file"
  entries_file="$(mktemp "$STATE_DIR/.state-entries.git.XXXXXX")"
  register_tmp "$entries_file"

  if ! (
    cd "$REPO_ROOT" || exit 1
    git ls-files -z --cached --others --exclude-standard
  ) > "$entries_file"; then
    return 1
  fi

  _capture_worktree_from_entries "$out_file" "$entries_file"
}

git_repo_has_ignored_paths() {
  local ignored_count
  ignored_count="$(
    git -C "$REPO_ROOT" ls-files --others -i --exclude-standard --directory --no-empty-directory -z 2>/dev/null \
    | wc -c \
    | tr -d '[:space:]'
  )"
  [[ "${ignored_count:-0}" -gt 0 ]]
}

should_use_git_state_fast_path() {
  case "$FIXING_STATE_METHOD" in
    full)
      return 1
      ;;
    auto|git)
      ;;
    *)
      return 1
      ;;
  esac

  command -v git >/dev/null 2>&1 || return 1
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1

  if git_repo_has_ignored_paths; then
    if [[ "$FIXING_STATE_METHOD" == "git" ]]; then
      fail "RALPH_FIXING_STATE_METHOD=git is unsafe with ignored paths; use auto or full"
    fi
    if [[ "$FIXING_STATE_METHOD" == "auto" ]]; then
      return 1
    fi
  fi

  return 0
}

diff_worktree_states() {
  local before_file="$1"
  local after_file="$2"
  local out_file="$3"

  # We use RS="\034" and FS="\v" (vertical tab) to support filenames with newlines/tabs.
  awk '
    BEGIN {
      RS="\034"
      FS="\v"
    }
    NR==FNR {
      if (NF >= 2) before[$1] = $2
      next
    }
    {
      if (NF >= 2) after[$1] = $2
    }
    END {
      for (path in before) {
        if (!(path in after) || before[path] != after[path]) {
          print path
        }
      }
      for (path in after) {
        if (!(path in before)) {
          print path
        }
      }
    }
  ' "$before_file" "$after_file" | LC_ALL=C sort -u > "$out_file"
}

enforce_fixing_scope() {
  local story_id="$1"
  local before_state_file="$2"
  local after_state_file="$3"
  local changed_paths_file
  local path
  local violations=()

  changed_paths_file="$(mktemp "$STATE_DIR/.state-diff.${story_id}.XXXXXX.txt")"
  register_tmp "$changed_paths_file"

  diff_worktree_states "$before_state_file" "$after_state_file" "$changed_paths_file"

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if is_runner_internal_path "$path"; then
      continue
    fi
    if ! path_matches_story_scope "$story_id" "$path"; then
      violations+=("$path")
    fi
  done < "$changed_paths_file"

  if [[ "${#violations[@]}" -gt 0 ]]; then
    local details=""
    for path in "${violations[@]}"; do
      details+=$'\n- '"$path"
    done
    fail "${RALPH_EXIT_SCOPE:-3}" "Story $story_id modified files outside scope:$details" "Check story scope patterns and changed paths"
  fi
}

repo_relative_dir() {
  local abs_dir="$1"
  if [[ "$abs_dir" == "$REPO_ROOT" ]]; then
    printf '.'
    return
  fi
  if [[ "$abs_dir" == "$REPO_ROOT/"* ]]; then
    printf '%s' "${abs_dir#"$REPO_ROOT"/}"
    return
  fi
  printf ''
}

cache_internal_paths() {
  SCRIPT_REL_IN_REPO="$(repo_relative_dir "$SCRIPT_DIR")"
  STATE_REL_IN_REPO="$(repo_relative_dir "$STATE_DIR")"
}

is_runner_internal_path() {
  local path="$1"
  if [[ -n "$STATE_REL_IN_REPO" ]]; then
    case "$path" in
      "$STATE_REL_IN_REPO"/*) return 0 ;;
    esac
  fi

  if [[ -n "$SCRIPT_REL_IN_REPO" ]]; then
    if [[ "$SCRIPT_REL_IN_REPO" == "." ]]; then
      case "$path" in
        .prompt.*|.last-message.*|.prd.*.tmp) return 0 ;;
      esac
    else
      case "$path" in
        "$SCRIPT_REL_IN_REPO"/.prompt.*|"$SCRIPT_REL_IN_REPO"/.last-message.*|"$SCRIPT_REL_IN_REPO"/.prd.*.tmp) return 0 ;;
      esac
    fi
  fi

  return 1
}
