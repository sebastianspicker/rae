# shellcheck shell=bash
# Guards rewrite and push operations with clean-tree, upstream, and restoration checks.

# Restore remotes from the pre-rewrite snapshot so a failed workflow leaves transport configuration intact.
restore_remotes_from_backup() {
  local repo_path="$1"
  local backup_file="$2"
  local remote_name kind url added_names=""
  while IFS=$'\t' read -r remote_name kind url; do
    [[ -z "$remote_name" || -z "$kind" || -z "$url" ]] && continue
    if [[ " $added_names " != *" $remote_name "* ]]; then
      git -C "$repo_path" remote add "$remote_name" "$url" 2>/dev/null || true
      added_names="$added_names $remote_name"
      if [[ "$kind" == "push" ]]; then
        git -C "$repo_path" remote set-url --push "$remote_name" "$url" 2>/dev/null || true
      fi
    elif [[ "$kind" == "fetch" ]]; then
      git -C "$repo_path" remote set-url --add "$remote_name" "$url" 2>/dev/null || true
    else
      git -C "$repo_path" remote set-url --push --add "$remote_name" "$url" 2>/dev/null || true
    fi
  done <"$backup_file"
}

resolve_target_remote() {
  local backup_file="$1"
  local canonical_norm remote_name kind url
  local matches=""
  canonical_norm="$(normalize_github_url_for_compare "$2")"
  [[ -n "$canonical_norm" ]] || return 1
  while IFS=$'\t' read -r remote_name kind url; do
    [[ "$kind" == "fetch" || "$kind" == "push" ]] || continue
    if [[ "$(normalize_github_url_for_compare "$url")" == "$canonical_norm" \
      && " $matches " != *" $remote_name "* ]]; then
      matches="$matches $remote_name"
    fi
  done <"$backup_file"
  matches="${matches# }"
  [[ -n "$matches" && "$matches" != *" "* ]] || return 1
  printf '%s\n' "$matches"
}

# Push rewrites require an exact upstream baseline to avoid overwriting concurrent remote history.
capture_upstream_state() {
  local repo_path="$1"
  local tracking
  tracking="$(git -C "$repo_path" for-each-ref \
    --format='%(upstream:remotename)%09%(upstream:remoteref)' \
    "refs/heads/$CURRENT_BRANCH")"
  UPSTREAM_REMOTE="${tracking%%$'\t'*}"
  UPSTREAM_REMOTE_REF="${tracking#*$'\t'}"
  if [[ -z "$UPSTREAM_REMOTE" || -z "$UPSTREAM_REMOTE_REF" || "$UPSTREAM_REMOTE_REF" == "$tracking" ]]; then
    log_error "Current branch must track a remote branch before push rewrite: $repo_path"
    return 1
  fi
  EXPECTED_UPSTREAM_OID="$(git -C "$repo_path" rev-parse --verify "$UPSTREAM_REMOTE_REF^{commit}" 2>/dev/null)" || {
    log_error "Could not resolve upstream commit: $UPSTREAM_REMOTE_REF"
    return 1
  }
  local ahead_behind ahead_count behind_count
  ahead_behind="$(git -C "$repo_path" rev-list --left-right --count "HEAD...$UPSTREAM_REMOTE_REF")" || return 1
  ahead_count="${ahead_behind%%$'\t'*}"
  behind_count="${ahead_behind#*$'\t'}"
  if [[ "$ahead_count" -ne 0 || "$behind_count" -ne 0 ]]; then
    log_error "Branch must be in sync with upstream before push rewrite (ahead=$ahead_count behind=$behind_count): $repo_path"
    return 1
  fi
}

# Reject unsafe repository states before any rewrite can mutate local or remote history.
validate_repo_input() {
  local github_url="$1"
  local repo_path="$2"
  if ! parse_github_url "$github_url"; then
    log_error "Unsupported GitHub URL: $github_url"
    return 1
  fi
  USERNAME="$PARSED_USERNAME"
  REPONAME="$PARSED_REPONAME"
  CANONICAL_URL="$PARSED_CANONICAL_URL"
  [[ "$repo_path" == /* ]] || {
    log_error "Local repo path must be absolute: $repo_path"
    return 1
  }
  [[ -d "$repo_path" ]] || {
    log_error "Local repo path does not exist: $repo_path"
    return 1
  }
  git -C "$repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    log_error "Path is not a git repository: $repo_path"
    return 1
  }
  CURRENT_BRANCH="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD)" || {
    log_error "Repository is in detached HEAD state: $repo_path"
    return 1
  }
  ORIGINAL_HEAD_OID="$(git -C "$repo_path" rev-parse --verify "HEAD^{commit}")" || return 1
  if [[ "$VALIDATE_ONLY" == false && "$DRY_RUN" == false \
    && -n "$(git -C "$repo_path" status --porcelain)" ]]; then
    log_error "Repository worktree must be clean before rewrite: $repo_path"
    return 1
  fi
  if [[ "$NO_PUSH" == false ]]; then
    capture_upstream_state "$repo_path" || return 1
  fi
  if [[ "$VALIDATE_ONLY" == true ]]; then
    print_validation_result "$repo_path"
  fi
}

print_validation_result() {
  local repo_path="$1"
  if [[ "$QUIET" == true ]]; then
    log_ok "$USERNAME/$REPONAME: validation passed"
    return
  fi
  printf '%s\n' "---" "Validated: $USERNAME/$REPONAME" \
    "  url:    $CANONICAL_URL" "  local:  $repo_path" \
    "  branch: $CURRENT_BRANCH" "  targets: $TARGET_SUMMARY"
  if [[ "$NO_PUSH" == false ]]; then
    printf '  upstream lease: %s:%s\n' "$UPSTREAM_REMOTE_REF" "$EXPECTED_UPSTREAM_OID"
  fi
  log_ok "All checks passed (validate-only; no changes made)."
}

create_transaction_ref_names() {
  local suffix
  suffix="$(date +%Y%m%d-%H%M%S)-$("$PYTHON_BIN" - <<'PY'
import secrets
print(secrets.token_hex(6))
PY
)"
  BACKUP_BRANCH="${BACKUP_BRANCH_PREFIX}${suffix}"
  TRANSACTION_REF="${TRANSACTION_REF_PREFIX}${suffix}"
}

zero_oid() {
  local object_format width
  object_format="$(git -C "$1" rev-parse --show-object-format)" || return 1
  case "$object_format" in
  sha1) width=40 ;;
  sha256) width=64 ;;
  *) return 1 ;;
  esac
  printf '%0*d\n' "$width" 0
}

worktree_and_index_are_clean() {
  [[ -z "$(git -C "$1" status --porcelain)" ]]
}

recovery_ref_matches_original() {
  local repo_path="$1"
  local recovery_oid
  recovery_oid="$(git -C "$repo_path" rev-parse --verify "refs/heads/$BACKUP_BRANCH^{commit}" 2>/dev/null)" || return 1
  [[ "$recovery_oid" == "$ORIGINAL_HEAD_OID" ]]
}

transaction_ref_matches() {
  local repo_path="$1"
  local expected_oid="$2"
  local actual_oid
  actual_oid="$(git -C "$repo_path" rev-parse --verify "$TRANSACTION_REF^{commit}" 2>/dev/null)" || return 1
  [[ "$actual_oid" == "$expected_oid" ]]
}

head_and_worktree_match() {
  local repo_path="$1"
  local expected_head="$2"
  local current_branch current_head
  current_branch="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD 2>/dev/null)" || return 1
  current_head="$(git -C "$repo_path" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  [[ "$current_branch" == "$CURRENT_BRANCH" && "$current_head" == "$expected_head" ]] || return 1
  worktree_and_index_are_clean "$repo_path"
}

transaction_state_matches() {
  head_and_worktree_match "$1" "$2" &&
    recovery_ref_matches_original "$1" &&
    transaction_ref_matches "$1" "$REWRITTEN_HEAD_OID"
}

revalidate_before_rewrite() {
  local repo_path="$1"
  if ! head_and_worktree_match "$repo_path" "$ORIGINAL_HEAD_OID"; then
    log_error "Repository changed after preflight; refusing history rewrite: $repo_path"
    return 1
  fi
}

manual_recovery_instructions() {
  local repo_path="$1"
  log_error "Automatic ref rollback was refused."
  log_error "Recovery branch retained: $BACKUP_BRANCH ($ORIGINAL_HEAD_OID)"
  log_error "Rewritten transaction ref retained: $TRANSACTION_REF ($REWRITTEN_HEAD_OID)"
  log_error "Inspect with: git -C $(printf '%q' "$repo_path") diff $BACKUP_BRANCH..$CURRENT_BRANCH"
  log_error "Recover the branch ref only after preserving local changes and verifying the expected OIDs."
}

capture_rewritten_head_from_commit_map() {
  local repo_path="$1"
  local commit_map map_value
  commit_map="$(git -C "$repo_path" rev-parse --path-format=absolute \
    --git-path filter-repo/commit-map)" || return 1
  [[ -f "$commit_map" ]] || {
    log_error "git-filter-repo commit map is missing: $commit_map"
    return 1
  }
  map_value="$(awk -v original="$ORIGINAL_HEAD_OID" '$1 == original { print $2 }' "$commit_map")"
  if [[ -z "$map_value" || "$map_value" == *$'\n'* || "$map_value" =~ ^0+$ ]]; then
    log_error "Could not derive one rewritten OID for $ORIGINAL_HEAD_OID from $commit_map"
    return 1
  fi
  git -C "$repo_path" rev-parse --verify "$map_value^{commit}" >/dev/null 2>&1 || {
    log_error "Commit map contains an invalid rewritten OID: $map_value"
    return 1
  }
  REWRITTEN_HEAD_OID="$map_value"
}

original_and_rewritten_trees_match() {
  local repo_path="$1"
  local original_tree rewritten_tree
  original_tree="$(git -C "$repo_path" rev-parse --verify "$ORIGINAL_HEAD_OID^{tree}")" || return 1
  rewritten_tree="$(git -C "$repo_path" rev-parse --verify "$REWRITTEN_HEAD_OID^{tree}")" || return 1
  [[ "$original_tree" == "$rewritten_tree" ]]
}

backup_remote_configuration() {
  local repo_path="$1"
  create_temp_file
  BACKUP_REMOTES_TMP="$CREATED_TEMP_FILE"
  git -C "$repo_path" remote -v |
    awk '{gsub(/[()]/, "", $3); print $1"\t"$3"\t"$2}' >"$BACKUP_REMOTES_TMP"
}

do_rewrite_and_restore_remotes() {
  local repo_path="$1"
  local null_oid
  create_transaction_ref_names
  if [[ "$QUIET" == false ]]; then
    printf '%s\n' "---" "Processing: $USERNAME/$REPONAME" \
      "  local:      $repo_path" "  branch:     $CURRENT_BRANCH" \
      "  targets:    $TARGET_SUMMARY" "  dry-run:    $DRY_RUN" "  no-push:    $NO_PUSH"
  fi
  revalidate_before_rewrite "$repo_path" || return 1
  backup_remote_configuration "$repo_path" || return 1
  null_oid="$(zero_oid "$repo_path")" || return 1
  run_cmd git -C "$repo_path" update-ref "refs/heads/$BACKUP_BRANCH" \
    "$ORIGINAL_HEAD_OID" "$null_oid" || return 1
  run_cmd git -C "$repo_path" update-ref "$TRANSACTION_REF" \
    "$ORIGINAL_HEAD_OID" "$null_oid" || return 1
  if ! revalidate_before_rewrite "$repo_path"; then
    log_error "Recovery and transaction refs retained: $BACKUP_BRANCH, $TRANSACTION_REF"
    return 1
  fi
  if [[ "$DRY_RUN" == false ]]; then
    transaction_ref_matches "$repo_path" "$ORIGINAL_HEAD_OID" || {
      log_error "Pinned transaction ref changed before rewrite: $TRANSACTION_REF"
      return 1
    }
  fi
  if [[ -n "$BACKUP_REMOTE" && "$NO_PUSH" == false ]]; then
    run_cmd git -C "$repo_path" push "$BACKUP_REMOTE" \
      "$ORIGINAL_HEAD_OID:refs/heads/$BACKUP_BRANCH" || return 1
    log_info "Retaining remote recovery branch $BACKUP_REMOTE/$BACKUP_BRANCH"
  fi
  if ! run_cmd git -C "$repo_path" filter-repo --refs "$TRANSACTION_REF" --force \
    --message-callback "$MESSAGE_CALLBACK"; then
    restore_remotes_from_backup "$repo_path" "$BACKUP_REMOTES_TMP"
    log_error "git-filter-repo failed; recovery branch retained: $BACKUP_BRANCH"
    return 1
  fi
  if [[ "$DRY_RUN" == false ]]; then
    capture_rewritten_head_from_commit_map "$repo_path" || return 1
    if ! recovery_ref_matches_original "$repo_path" ||
      ! transaction_ref_matches "$repo_path" "$REWRITTEN_HEAD_OID" ||
      ! worktree_and_index_are_clean "$repo_path"; then
      log_error "Transaction refs or local files changed during rewrite; refusing branch promotion."
      return 1
    fi
  fi
  if [[ "$DRY_RUN" == false ]]; then
    restore_remotes_from_backup "$repo_path" "$BACKUP_REMOTES_TMP"
  else
    log_info "Would restore remotes after git-filter-repo"
  fi
  if [[ "$DRY_RUN" == false ]]; then
    if ! original_and_rewritten_trees_match "$repo_path"; then
      log_error "Original and rewritten trees differ; refusing branch promotion."
      return 1
    fi
    if ! run_cmd git -C "$repo_path" update-ref "refs/heads/$CURRENT_BRANCH" \
      "$REWRITTEN_HEAD_OID" "$ORIGINAL_HEAD_OID"; then
      log_error "Branch moved during rewrite; recovery and transaction refs retained."
      return 1
    fi
    if ! transaction_state_matches "$repo_path" "$REWRITTEN_HEAD_OID"; then
      log_error "Local state changed at branch-promotion boundary; transaction refs retained."
      return 1
    fi
  fi
}

push_rewritten_branch() {
  local repo_path="$1"
  TARGET_REMOTE="$(resolve_target_remote "$BACKUP_REMOTES_TMP" "$CANONICAL_URL")" || {
    log_error "Could not resolve one exact GitHub remote for push."
    return 1
  }
  if [[ "$TARGET_REMOTE" != "$UPSTREAM_REMOTE" ]]; then
    log_error "Resolved GitHub remote '$TARGET_REMOTE' does not match tracked upstream remote '$UPSTREAM_REMOTE'."
    return 1
  fi
  run_cmd git -C "$repo_path" push "$TARGET_REMOTE" \
    "--force-with-lease=$UPSTREAM_REMOTE_REF:$EXPECTED_UPSTREAM_OID" \
    "$REWRITTEN_HEAD_OID:$UPSTREAM_REMOTE_REF"
}

check_target_trailers() {
  local repo_path="$1"
  local branch="${2:-}"
  local scan_rc=0
  local messages_file
  if [[ -z "$branch" ]]; then
    branch="${CURRENT_BRANCH:-}"
  fi
  if [[ -z "$branch" ]]; then
    branch="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD)" || return 1
  fi
  messages_file="$(mktemp)" || return 1
  if ! git -C "$repo_path" log "$branch" --format='%B' >"$messages_file"; then
    rm -f "$messages_file"
    log_warn "Could not scan rewritten branch: $branch"
    return 1
  fi
  if "$PYTHON_BIN" -c '
import json
import re
import sys

text = open(sys.argv[2], "rb").read().decode("utf-8", errors="ignore")
for target in json.loads(sys.argv[1]):
    name = re.escape(target["name"])
    email = re.escape(target["email"])
    pattern = rf"(?im)^Co-authored-by:\s*{name}\s*<{email}>\s*$"
    if re.search(pattern, text):
        raise SystemExit(1)
' "$TARGETS_JSON" "$messages_file"
  then
    scan_rc=0
  else
    scan_rc=$?
  fi
  rm -f "$messages_file"
  if [[ $scan_rc -ne 0 ]]; then
    log_warn "Configured co-author trailer remains or the rewritten branch could not be scanned."
    return 1
  fi
  log_ok "No configured co-author trailers remain on $branch."
}

delete_transaction_refs_atomically() {
  local repo_path="$1"
  local update_file
  create_temp_file
  update_file="$CREATED_TEMP_FILE"
  {
    printf 'start\n'
    printf 'verify refs/heads/%s %s\n' "$CURRENT_BRANCH" "$REWRITTEN_HEAD_OID"
    printf 'delete refs/heads/%s %s\n' "$BACKUP_BRANCH" "$ORIGINAL_HEAD_OID"
    printf 'delete %s %s\n' "$TRANSACTION_REF" "$REWRITTEN_HEAD_OID"
    printf 'prepare\ncommit\n'
  } >"$update_file"
  [[ "$VERBOSE" == true ]] &&
    printf '+ git -C %q update-ref --stdin --no-deref # atomic transaction cleanup\n' "$repo_path"
  if [[ "$DRY_RUN" == false ]]; then
    git -C "$repo_path" update-ref --stdin --no-deref <"$update_file"
  fi
}

verify_and_cleanup() {
  local repo_path="$1"
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Skipped verification and cleanup in dry-run mode."
    return 0
  fi
  if ! transaction_state_matches "$repo_path" "$REWRITTEN_HEAD_OID"; then
    log_warn "Local state changed after rewrite/push; retaining recovery branch: $BACKUP_BRANCH"
    return 1
  fi
  check_target_trailers "$repo_path" "$REWRITTEN_HEAD_OID" || {
    log_error "Verification failed; retaining recovery branch: $BACKUP_BRANCH"
    return 1
  }
  delete_transaction_refs_atomically "$repo_path" || {
    log_error "Atomic transaction cleanup failed; recovery and transaction refs retained."
    return 1
  }
  return 0
}

rollback_local_rewrite() {
  local repo_path="$1"
  if ! transaction_state_matches "$repo_path" "$REWRITTEN_HEAD_OID"; then
    log_error "Automatic rollback refused because the repository transaction state changed."
    return 1
  fi
  if ! original_and_rewritten_trees_match "$repo_path"; then
    log_error "Automatic rollback refused because original and rewritten trees differ."
    return 1
  fi
  if ! run_cmd git -C "$repo_path" update-ref "refs/heads/$CURRENT_BRANCH" \
    "$ORIGINAL_HEAD_OID" "$REWRITTEN_HEAD_OID"; then
    log_error "Automatic rollback compare-and-swap failed."
    return 1
  fi
  if head_and_worktree_match "$repo_path" "$ORIGINAL_HEAD_OID" &&
    recovery_ref_matches_original "$repo_path"; then
    return 0
  fi
  log_error "Repository changed at the rollback boundary; attempting to restore the rewritten branch ref."
  run_cmd git -C "$repo_path" update-ref "refs/heads/$CURRENT_BRANCH" \
    "$REWRITTEN_HEAD_OID" "$ORIGINAL_HEAD_OID" || true
  return 1
}

process_one_repo() {
  local github_url="$1"
  local repo_path="$2"
  validate_repo_input "$github_url" "$repo_path" || return 1
  [[ "$VALIDATE_ONLY" == true ]] && return 0
  do_rewrite_and_restore_remotes "$repo_path" || return 1
  if [[ "$DRY_RUN" == true ]]; then
    [[ "$NO_PUSH" == false ]] &&
      log_info "Would push the commit-map-derived rewritten OID with the captured exact lease."
    verify_and_cleanup "$repo_path"
    return
  fi
  if [[ "$NO_PUSH" == false ]] && ! transaction_state_matches "$repo_path" "$REWRITTEN_HEAD_OID"; then
    log_error "Repository transaction state changed before push; refusing remote update."
    manual_recovery_instructions "$repo_path"
    return 1
  fi
  if [[ "$NO_PUSH" == false ]] && ! push_rewritten_branch "$repo_path"; then
    if rollback_local_rewrite "$repo_path"; then
      log_warn "Push failed; restored local branch to pre-rewrite commit $ORIGINAL_HEAD_OID"
    else
      manual_recovery_instructions "$repo_path"
    fi
    return 1
  fi
  [[ "$NO_PUSH" == true ]] && log_info "History rewritten locally; no remote push requested."
  verify_and_cleanup "$repo_path" || return 1
  [[ "$QUIET" == true ]] && log_ok "$USERNAME/$REPONAME: done"
  return 0
}
