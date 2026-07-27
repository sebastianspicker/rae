# shellcheck shell=bash
# Report/PRD persistence, progress, learnings sync, failure/skip handling.
# Sourced by runner.sh; expects core.sh, config.sh, prd.sh, runner_scope.sh.

maybe_require_learning_entry_update() {
  local story_id="$1"
  local baseline_signature="$2"
  local learnings_file
  local current_signature

  learnings_file="$(transaction_tool_script_dir)/learnings.md"

  if [[ "$MODE" != "fixing" ]] || ! is_true "$REQUIRE_LEARNING_ENTRY_FOR_FIXING"; then
    return
  fi

  if [[ ! -f "$learnings_file" ]]; then
    fail "fixing story $story_id requires learnings.md update, but file is missing: $learnings_file"
  fi

  current_signature="$(file_signature_or_missing "$learnings_file")"
  if [[ "$current_signature" == "$baseline_signature" ]]; then
    fail "fixing story $story_id requires at least one new learnings.md entry (see scripts/record_learning.sh)"
  fi
}

write_report_atomically() {
  local last_message_file="$1"
  local report_rel="$2"
  local report_abs="$TOOL_REPO_ROOT/$report_rel"
  local report_dir
  local tmp_report

  report_dir="$(dirname "$report_abs")"
  enforce_report_target_confinement "$report_abs" "$report_rel" "$TOOL_REPO_ROOT"
  mkdir -p "$report_dir"
  enforce_report_target_confinement "$report_abs" "$report_rel" "$TOOL_REPO_ROOT"

  tmp_report="$(mktemp "$report_dir/.ralph-report.XXXXXX.tmp")"
  register_tmp "$tmp_report"

  cp "$last_message_file" "$tmp_report"
  enforce_report_target_confinement "$report_abs" "$report_rel" "$TOOL_REPO_ROOT"
  mv "$tmp_report" "$report_abs"
}

# Atomic PRD story update: validates story uniqueness, applies jq filter, writes atomically.
# Usage: _update_story_in_prd <jq_filter> [--arg key val ...]
# The filter receives $id and $now automatically; pass additional --arg pairs as needed.
_update_story_in_prd() {
  local jq_filter="$1"; shift
  local now_iso tmp_prd transaction_prd
  now_iso="$(ralph_iso_utc)"
  transaction_prd="$(transaction_tool_script_dir)/prd.json"
  tmp_prd="$(mktemp "$(transaction_tool_script_dir)/.prd.XXXXXX.tmp")"
  register_tmp "$tmp_prd"
  jq --arg now "$now_iso" "$@" "$jq_filter" "$transaction_prd" > "$tmp_prd"
  mv "$tmp_prd" "$transaction_prd"
}

mark_story_passed() {
  local story_id="$1"
  local report_rel="$2"

  # shellcheck disable=SC2016
  _update_story_in_prd \
    "$PRD_STORY_BY_ID_GUARD"' | .stories = (.stories | map(if .id == $id then (. + {passes: true, skipped: false, completed_at: $now, report_path: $report} | del(.skip_reason, .skipped_at)) else . end))' \
    --arg id "$story_id" --arg report "$report_rel"
}

story_failure_state_file() {
  printf '%s/.story-failures.tsv' "$STATE_DIR"
}

ensure_story_failure_state_file() {
  local failures_file
  failures_file="$(story_failure_state_file)"
  if [[ ! -f "$failures_file" ]]; then
    : > "$failures_file"
  fi
}

get_story_failure_count() {
  local story_id="$1"
  local failures_file

  failures_file="$(story_failure_state_file)"
  if [[ ! -f "$failures_file" ]]; then
    printf '0'
    return
  fi

  awk -F '\t' -v id="$story_id" '
    $1 == id { print $2; found=1; exit }
    END { if (!found) print 0 }
  ' "$failures_file"
}

set_story_failure_count() {
  local story_id="$1"
  local count="$2"
  local failures_file tmp_file

  ensure_story_failure_state_file
  failures_file="$(story_failure_state_file)"
  tmp_file="$(mktemp "$STATE_DIR/.story-failures.XXXXXX.tmp")"
  register_tmp "$tmp_file"

  awk -F '\t' -v id="$story_id" -v count="$count" '
    BEGIN { written=0 }
    $1 == id {
      if (count > 0) {
        print id "\t" count
      }
      written=1
      next
    }
    { print $0 }
    END {
      if (!written && count > 0) {
        print id "\t" count
      }
    }
  ' "$failures_file" > "$tmp_file"

  mv "$tmp_file" "$failures_file"
}

increment_story_failure_count() {
  local story_id="$1"
  local current next

  current="$(get_story_failure_count "$story_id")"
  next=$((current + 1))
  set_story_failure_count "$story_id" "$next"
  printf '%s' "$next"
}

clear_story_failure_count() {
  local story_id="$1"
  set_story_failure_count "$story_id" 0
}

mark_story_skipped() {
  local story_id="$1"
  local reason="$2"

  # shellcheck disable=SC2016
  _update_story_in_prd \
    "$PRD_STORY_BY_ID_GUARD"' | .stories = (.stories | map(if .id == $id then (. + {passes: false, skipped: true, skip_reason: $reason, skipped_at: $now} | del(.report_path, .completed_at)) else . end))' \
    --arg id "$story_id" --arg reason "$reason"
}

append_progress_log_best_effort() {
  local story_id="$1"
  local report_rel="$2"
  local logger="$SCRIPT_DIR/scripts/append_progress_entry.sh"
  local title

  if ! is_true "$AUTO_PROGRESS_LOG_APPEND"; then
    return
  fi
  if [[ ! -x "$logger" ]]; then
    return
  fi

  title="$(story_title "$story_id")"
  if "$logger" --story "$story_id" --mode "$MODE" --title "$title" --report "$report_rel" >/dev/null 2>&1; then
    log_event "INFO progress_log_appended story=$story_id"
  else
    log_event "WARN progress_log_append_failed story=$story_id"
  fi
}

sync_agents_from_learnings_best_effort() {
  local story_id="$1"
  local sync_script="$SCRIPT_DIR/scripts/sync_agents_from_learnings.sh"

  if ! is_true "$AUTO_SYNC_AGENTS_FROM_LEARNINGS"; then
    return
  fi
  if [[ "$MODE" != "fixing" ]]; then
    return
  fi
  if [[ ! -x "$sync_script" ]]; then
    return
  fi
  if ! path_matches_story_scope "$story_id" "AGENTS.md"; then
    log_event "WARN agents_sync_skipped_out_of_scope story=$story_id path=AGENTS.md"
    return
  fi

  if "$sync_script" --root "$SCRIPT_DIR" >/dev/null 2>&1; then
    log_event "INFO agents_synced_from_learnings"
  else
    log_event "WARN agents_sync_from_learnings_failed"
  fi
}

handle_story_failure() {
  local story_id="$1"
  local rc="$2"
  local failures reason

  log_event "STORY_FAIL id=$story_id mode=$MODE rc=$rc"

  if [[ "$SKIP_AFTER_FAILURES" -le 0 ]]; then
    fail "${RALPH_EXIT_TOOL:-4}" "Codex exec failed for story $story_id (rc=$rc, see $RUN_LOG for redacted details)"
  fi

  failures="$(increment_story_failure_count "$story_id")"
  if [[ "$failures" -ge "$SKIP_AFTER_FAILURES" ]]; then
    reason="Skipped after $failures failed runs (last_rc=$rc)"
    mark_story_skipped "$story_id" "$reason"
    clear_story_failure_count "$story_id"
    refresh_progress_snapshot_best_effort
    log_event "STORY_SKIPPED id=$story_id reason=$reason"
    log "story=$story_id skipped after repeated failures (count=$failures rc=$rc)"
    return 0
  fi

  fail "${RALPH_EXIT_TOOL:-4}" "Codex exec failed for story $story_id (rc=$rc, failure_count=$failures skip_after=$SKIP_AFTER_FAILURES)"
}

refresh_progress_snapshot_best_effort() {
  local generator="$SCRIPT_DIR/scripts/generate_progress.sh"
  local progress_file="$SCRIPT_DIR/progress.txt"

  if ! is_true "$AUTO_PROGRESS_REFRESH"; then
    return
  fi
  if [[ ! -f "$generator" ]]; then
    return
  fi
  if [[ ! -f "$progress_file" ]]; then
    return
  fi

  if "$generator" "$PRD_FILE" "$progress_file" >/dev/null 2>&1; then
    log_event "INFO progress_snapshot_refreshed path=$progress_file"
  else
    log_event "WARN progress_snapshot_refresh_failed path=$progress_file"
  fi
}

reset_story() {
  local story_id="$1"

  # shellcheck disable=SC2016
  _update_story_in_prd \
    "$PRD_STORY_BY_ID_GUARD"' | .stories = (.stories | map(if .id == $id then (del(.completed_at, .report_path, .skipped_at, .skip_reason) | . + {passes: false, skipped: false}) else . end))' \
    --arg id "$story_id"

  clear_story_failure_count "$story_id"
  log "Story $story_id has been reset."
  log_event "STORY_RESET id=$story_id"
}

reset_skipped_stories() {
  local count
  count="$(jq '[.stories[] | select(.skipped == true)] | length' "$PRD_FILE")"

  if [[ "${count:-0}" -eq 0 ]]; then
    log "No skipped stories found."
    return
  fi

  local tmp_prd
  tmp_prd="$(mktemp "$SCRIPT_DIR/.prd.XXXXXX.tmp")"
  register_tmp "$tmp_prd"
  jq '.stories = (.stories | map(if .skipped == true then (del(.completed_at, .report_path, .skipped_at, .skip_reason) | . + {passes: false, skipped: false}) else . end))' "$PRD_FILE" > "$tmp_prd"
  mv "$tmp_prd" "$PRD_FILE"

  # Clear all failure counts for reset stories
  local failures_file
  failures_file="$(story_failure_state_file)"
  if [[ -f "$failures_file" ]]; then
    : > "$failures_file"
  fi

  log "Reset $count skipped stories for retry."
  log_event "STORIES_RESET_SKIPPED count=$count"
}

persist_story_result() {
  local story_id="$1"
  local report_rel="$2"
  local last_message_file="$3"
  local learnings_baseline_signature="${4:-__missing__}"

  maybe_require_learning_entry_update "$story_id" "$learnings_baseline_signature"
  write_report_atomically "$last_message_file" "$report_rel"
  mark_story_passed "$story_id" "$report_rel"
  prepare_story_transaction "$story_id"
  verify_story_transaction "$story_id"
  promote_story_transaction "$story_id"
  clear_story_failure_count "$story_id"
  refresh_progress_snapshot_best_effort
  append_progress_log_best_effort "$story_id" "$report_rel"
  sync_agents_from_learnings_best_effort "$story_id"
  log_event "STORY_COMPLETE id=$story_id report=$report_rel"
}
