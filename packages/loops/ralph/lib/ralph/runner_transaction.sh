# shellcheck shell=bash
# Isolated external transaction for fixing stories.

transaction_pointer_file() {
  local helper
  helper="$(transaction_helper)"
  initialize_transaction_metadata_root
  "$PYTHON_EXECUTABLE" "$helper" pointer-path \
    --root "$REPO_ROOT_REAL" \
    --runtime "$STATE_DIR_REAL" \
    --metadata-root "$TRANSACTION_METADATA_ROOT"
}

transaction_helper() {
  printf '%s/scripts/ralph_fs_txn.py' "$SCRIPT_DIR"
}

initialize_transaction_metadata_root() {
  local configured
  [[ -z "${TRANSACTION_METADATA_ROOT:-}" ]] || return 0
  configured="${RALPH_TRANSACTION_METADATA_ROOT:-${HOME:?HOME is required}/.local/state/ralph-fs-transactions}"
  [[ "$configured" == /* ]] || fail "RALPH_TRANSACTION_METADATA_ROOT must be absolute"
  mkdir -p "$configured" || fail "Could not create transaction metadata root: $configured"
  chmod 700 "$configured" || fail "Could not make transaction metadata root private: $configured"
  TRANSACTION_METADATA_ROOT="$(cd "$configured" && pwd -P)" \
    || fail "Could not resolve transaction metadata root: $configured"
}

transaction_tool_script_dir() {
  local live_script_dir
  live_script_dir="$(cd "$SCRIPT_DIR" && pwd -P)" || fail "Could not resolve Ralph script directory"
  if [[ "$live_script_dir" == "$REPO_ROOT_REAL" ]]; then
    printf '%s' "$TOOL_REPO_ROOT"
  elif [[ "$live_script_dir" == "$REPO_ROOT_REAL/"* ]]; then
    printf '%s/%s' "$TOOL_REPO_ROOT" "${live_script_dir#"$REPO_ROOT_REAL"/}"
  else
    fail "Ralph script directory resolves outside repository: $SCRIPT_DIR"
  fi
}

transaction_identity_args() {
  initialize_transaction_metadata_root
  TRANSACTION_IDENTITY_ARGS=(
    --root "$REPO_ROOT_REAL"
    --runtime "$STATE_DIR_REAL"
    --metadata-root "$TRANSACTION_METADATA_ROOT"
    --pointer "$(transaction_pointer_file)"
  )
}

# Recovery validates caller identities before touching only paths journaled as promoted.
recover_story_transaction() {
  local pointer helper
  local -a TRANSACTION_IDENTITY_ARGS
  initialize_transaction_metadata_root
  pointer="$(transaction_pointer_file)"
  [[ -e "$pointer" || -L "$pointer" ]] || return 0
  helper="$(transaction_helper)"
  transaction_identity_args
  "$PYTHON_EXECUTABLE" "$helper" recover "${TRANSACTION_IDENTITY_ARGS[@]}" \
    || fail "${RALPH_EXIT_SCOPE:-3}" "Could not recover interrupted fixing transaction"
  log_event "INFO fixing_transaction_recovered"
}

# Codex runs inside the returned mirror, outside the live checkout and runner metadata.
begin_story_transaction() {
  local story_id="$1"
  local helper
  local -a TRANSACTION_IDENTITY_ARGS

  [[ "$MODE" == "fixing" ]] || return 0
  [[ -z "${ACTIVE_TXN_JOURNAL:-}" ]] || fail "A fixing transaction is already active"
  helper="$(transaction_helper)"
  transaction_identity_args
  ACTIVE_TXN_JOURNAL="$(
    "$PYTHON_EXECUTABLE" "$helper" mirror "${TRANSACTION_IDENTITY_ARGS[@]}"
  )" || fail "${RALPH_EXIT_SCOPE:-3}" "Could not create isolated filesystem transaction for story $story_id"
  [[ -n "$ACTIVE_TXN_JOURNAL" ]] || fail "Filesystem transaction helper returned an empty journal path"
  TOOL_REPO_ROOT="$(
    "$PYTHON_EXECUTABLE" "$helper" workspace \
      "${TRANSACTION_IDENTITY_ARGS[@]}" \
      --journal "$ACTIVE_TXN_JOURNAL"
  )" || fail "${RALPH_EXIT_SCOPE:-3}" "Could not resolve isolated transaction workspace for story $story_id"
  [[ -d "$TOOL_REPO_ROOT" ]] || fail "Filesystem transaction helper returned an invalid workspace"
  log_event "INFO fixing_transaction_started story=$story_id"
}

# Reject provider changes outside story scope while all edits are still isolated.
validate_staged_changes() {
  local story_id="$1"
  local helper path encoded_diff tool_script_dir prd_rel
  local -a violations=() TRANSACTION_IDENTITY_ARGS

  [[ "$MODE" == "fixing" ]] || return 0
  [[ -n "${ACTIVE_TXN_JOURNAL:-}" ]] || fail "No active fixing transaction"
  helper="$(transaction_helper)"
  transaction_identity_args
  tool_script_dir="$(transaction_tool_script_dir)"
  if [[ "$tool_script_dir" == "$TOOL_REPO_ROOT" ]]; then
    prd_rel="prd.json"
  else
    prd_rel="${tool_script_dir#"$TOOL_REPO_ROOT"/}/prd.json"
  fi
  encoded_diff="$(mktemp "$STATE_DIR/.fixing-diff.${story_id}.XXXXXX")"
  register_tmp "$encoded_diff"
  if ! "$PYTHON_EXECUTABLE" "$helper" diff \
    "${TRANSACTION_IDENTITY_ARGS[@]}" \
    --journal "$ACTIVE_TXN_JOURNAL" >"$encoded_diff"; then
    discard_story_transaction "$story_id"
    fail "${RALPH_EXIT_SCOPE:-3}" "Could not inspect isolated changes for story $story_id"
  fi

  while IFS= read -r -d '' path; do
    if [[ "$path" == "$prd_rel" ]] || ! path_matches_story_scope "$story_id" "$path"; then
      violations+=("$path")
    fi
  done < <(
    "$PYTHON_EXECUTABLE" -c '
import base64
import os
import sys
with open(sys.argv[1], "rb") as handle:
  lines = list(handle)
for line in lines:
    encoded = line.strip()
    if encoded:
        os.write(1, base64.urlsafe_b64decode(encoded) + b"\0")
' "$encoded_diff"
  )

  if [[ "${#violations[@]}" -gt 0 ]]; then
    local details=""
    for path in "${violations[@]}"; do
      details+=$'\n- '"$path"
    done
    discard_story_transaction "$story_id"
    fail "${RALPH_EXIT_SCOPE:-3}" "Story $story_id modified files outside scope:$details" \
      "The isolated workspace was discarded; the live repository was not changed"
  fi
}

# Freeze the isolated result, including runner-owned report and PRD writes.
prepare_story_transaction() {
  local story_id="$1"
  local helper
  local -a TRANSACTION_IDENTITY_ARGS

  [[ "$MODE" == "fixing" ]] || return 0
  helper="$(transaction_helper)"
  transaction_identity_args
  "$PYTHON_EXECUTABLE" "$helper" prepare \
    "${TRANSACTION_IDENTITY_ARGS[@]}" \
    --journal "$ACTIVE_TXN_JOURNAL" \
    || fail "${RALPH_EXIT_SCOPE:-3}" "Could not prepare filesystem transaction for story $story_id"
}

# Report changed-path drift before promotion. Promotion repeats this CAS internally.
verify_story_transaction() {
  local story_id="$1"
  local helper drift drift_fallback
  local -a TRANSACTION_IDENTITY_ARGS

  [[ "$MODE" == "fixing" ]] || return 0
  helper="$(transaction_helper)"
  transaction_identity_args
  if ! drift="$(
    "$PYTHON_EXECUTABLE" "$helper" verify \
      "${TRANSACTION_IDENTITY_ARGS[@]}" \
      --journal "$ACTIVE_TXN_JOURNAL" 2>&1
  )"; then
    drift_fallback="The isolated workspace was discarded; live files were preserved"
    discard_story_transaction "$story_id"
    fail "${RALPH_EXIT_SCOPE:-3}" "Live repository drift detected before promoting story $story_id" \
      "${drift:-$drift_fallback}"
  fi
}

# Apply only changed paths after compare-and-swap, then remove external metadata.
promote_story_transaction() {
  local story_id="$1"
  local helper output output_fallback rc
  local -a TRANSACTION_IDENTITY_ARGS

  [[ "$MODE" == "fixing" ]] || return 0
  [[ -n "${ACTIVE_TXN_JOURNAL:-}" ]] || fail "No active fixing transaction"
  helper="$(transaction_helper)"
  transaction_identity_args
  rc=0
  output="$(
    "$PYTHON_EXECUTABLE" "$helper" promote \
      "${TRANSACTION_IDENTITY_ARGS[@]}" \
      --journal "$ACTIVE_TXN_JOURNAL" 2>&1
  )" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    output_fallback="Promotion failed; transaction metadata was retained for safe recovery"
    fail "${RALPH_EXIT_SCOPE:-3}" "Could not promote isolated changes for story $story_id" \
      "${output:-$output_fallback}"
  fi
  ACTIVE_TXN_JOURNAL=""
  # shellcheck disable=SC2034 # Shared runner state is consumed after this module is sourced.
  ACTIVE_LEARNINGS_BASELINE_SIGNATURE="__missing__"
  TOOL_REPO_ROOT="$REPO_ROOT_REAL"
  log_event "INFO fixing_transaction_committed story=$story_id"
}

# A pre-promotion failure discards only the external workspace. If promotion was
# interrupted, the helper restores only journaled paths after drift checks.
discard_story_transaction() {
  local story_id="${1:-unknown}"
  local helper journal
  local -a TRANSACTION_IDENTITY_ARGS

  [[ -n "${ACTIVE_TXN_JOURNAL:-}" ]] || return 0
  helper="$(transaction_helper)"
  transaction_identity_args
  journal="$ACTIVE_TXN_JOURNAL"
  "$PYTHON_EXECUTABLE" "$helper" discard \
    "${TRANSACTION_IDENTITY_ARGS[@]}" \
    --journal "$journal" \
    || fail "${RALPH_EXIT_SCOPE:-3}" "Could not discard filesystem transaction for story $story_id"
  ACTIVE_TXN_JOURNAL=""
  # shellcheck disable=SC2034 # Shared runner state is consumed after this module is sourced.
  ACTIVE_LEARNINGS_BASELINE_SIGNATURE="__missing__"
  TOOL_REPO_ROOT="$REPO_ROOT_REAL"
  log_event "INFO fixing_transaction_discarded story=$story_id"
}

# Compatibility name for existing failure paths.
rollback_story_transaction() {
  discard_story_transaction "$@"
}
