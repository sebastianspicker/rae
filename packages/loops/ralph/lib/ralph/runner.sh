# shellcheck shell=bash
# Runner orchestration. Tool run, scope, and persistence live in runner_*.sh.
# RALPH_LIB_DIR is set by ralph.sh before this file is sourced.

# shellcheck source=lib/ralph/runner_scope.sh
source "$RALPH_LIB_DIR/runner_scope.sh"
# shellcheck source=lib/ralph/runner_transaction.sh
source "$RALPH_LIB_DIR/runner_transaction.sh"
# shellcheck source=lib/ralph/runner_tool.sh
source "$RALPH_LIB_DIR/runner_tool.sh"
# shellcheck source=lib/ralph/runner_persist.sh
source "$RALPH_LIB_DIR/runner_persist.sh"

select_next_open_story() {
  next_story_id
}

execute_story_run() {
  local story_id="$1"
  local prompt_file="$2"
  local last_message_file="$3"
  local codex_rc=0

  if is_true "${DRY_RUN:-false}"; then
    log "dry-run: would execute story=$story_id mode=$MODE (tool not invoked)"
    return 0
  fi

  if [[ "$MODE" == "fixing" ]]; then
    begin_story_transaction "$story_id"
    if is_true "$REQUIRE_LEARNING_ENTRY_FOR_FIXING"; then
      ACTIVE_LEARNINGS_BASELINE_SIGNATURE="$(
        file_signature_or_missing "$(transaction_tool_script_dir)/learnings.md"
      )"
    fi
  fi

  run_tool_once "$story_id" "$prompt_file" "$last_message_file" || codex_rc=$?

  if [[ "$MODE" == "fixing" ]]; then
    validate_staged_changes "$story_id"
  fi

  if [[ "$codex_rc" -ne 0 ]]; then
    rollback_story_transaction "$story_id"
    return "$codex_rc"
  fi
}

process_story() {
  local story_id="$1"
  local created_line
  local report_rel
  local report_rel_file
  local prompt_file
  local last_message_file

  if ! created_line="$(extract_created_line "$story_id")"; then
    return 1
  fi
  if [[ -z "$created_line" ]]; then
    fail "${RALPH_EXIT_PRD:-2}" "Story $story_id is missing a valid Created acceptance criterion" "Add exactly one acceptance criterion matching 'Created \`path.md\` ...' (see prd.schema.json)"
  fi
  report_rel_file="$(mktemp "$STATE_DIR/.report-path.${story_id}.XXXXXX.txt")"
  register_tmp "$report_rel_file"
  extract_report_path "$created_line" >"$report_rel_file"
  report_rel="$(cat "$report_rel_file")"

  if [[ "$MODE" == "fixing" ]]; then
    invalidate_detected_checks_cache
  fi

  prompt_file="$(mktemp "$STATE_DIR/.prompt.${story_id}.XXXXXX.md")"
  last_message_file="$(mktemp "$STATE_DIR/.last-message.${story_id}.XXXXXX.md")"
  register_tmp "$prompt_file"
  register_tmp "$last_message_file"

  build_prompt "$story_id" "$report_rel" "$prompt_file"

  log_event "STORY_START id=$story_id mode=$MODE report=$report_rel"
  log "story=$story_id mode=$MODE"

  execute_story_run "$story_id" "$prompt_file" "$last_message_file" || return $?
  if ! is_true "${DRY_RUN:-false}"; then
    persist_story_result "$story_id" "$report_rel" "$last_message_file" "$ACTIVE_LEARNINGS_BASELINE_SIGNATURE"
  else
    log "dry-run: would persist report=$report_rel for $story_id"
  fi
}
