# shellcheck shell=bash
# Tool execution: timeout, redaction, codex run, external-refs contract.
# Sourced by runner.sh; expects core.sh and config.sh globals.

run_with_timeout() {
  local -a cmd=("$@")
  local timeout_sec="${RALPH_TIMEOUT_SECONDS:-900}"

  if [[ ! "$timeout_sec" =~ ^[0-9]+$ ]] || [[ "$timeout_sec" -eq 0 ]]; then
    "${cmd[@]}"
    return
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=INT --kill-after=15 "$timeout_sec" "${cmd[@]}"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=INT --kill-after=15 "$timeout_sec" "${cmd[@]}"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os
import signal
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]

try:
    proc = subprocess.Popen(cmd, start_new_session=True)
    try:
        sys.exit(proc.wait(timeout=timeout))
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGINT)
        try:
            sys.exit(proc.wait(timeout=15))
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            sys.exit(124)
except subprocess.TimeoutExpired:
    sys.exit(124)
' "$timeout_sec" "${cmd[@]}"
    return
  fi

  log "timeout tool not found; running without timeout"
  "${cmd[@]}"
}

append_redacted_log() {
  local raw_log_file="$1"
  redact_stream <"$raw_log_file" >>"$RUN_LOG"
}

build_tool_env() {
  local -a allowed_vars=(
    PATH HOME TMPDIR TMP TEMP LANG LC_ALL TERM TERM_PROGRAM COLORTERM NO_COLOR
    USER LOGNAME SHELL PWD
    ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_INTERNAL_ORIGINATOR_OVERRIDE
    HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY
    SSL_CERT_FILE SSL_CERT_DIR
  )
  local -a env_pairs=()
  local var_name

  for var_name in "${allowed_vars[@]}"; do
    if [[ -n "${!var_name+x}" ]]; then
      env_pairs+=("$var_name=${!var_name}")
    fi
  done

  while IFS='=' read -r var_name _; do
    case "$var_name" in
    RALPH_* | CLAUDE_* | CODEX_* | FAKE_*)
      env_pairs+=("$var_name=${!var_name}")
      ;;
    esac
  done < <(env)

  printf '%s\n' "${env_pairs[@]}"
}

redact_stream() {
  sed -E \
    -e 's/((([A-Za-z_][A-Za-z0-9_]*)?(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)[:=][[:space:]]*["'\'':]?)[^[:space:]"'\''}{,]+/\1[REDACTED]/Ig' \
    -e 's/((--?(token|secret|password|api-key|api_key|access-key|access_key|private-key|private_key))([[:space:]]+|=))[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]])[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/(AKIA[0-9A-Z]{16})/[REDACTED]/g' \
    -e 's/\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/[REDACTED]/g' \
    -e 's/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/[REDACTED]/g'
}

emit_redacted_tool_excerpt() {
  local raw_log_file="$1"
  local line_count="${2:-25}"
  local tool_label="${3:-$TOOL}"
  local excerpt
  excerpt="$(redact_stream <"$raw_log_file" | tail -n "$line_count" || true)"
  [[ -n "$excerpt" ]] || return

  printf '[ralph] %s failure excerpt (redacted, last %s lines):\n' "$tool_label" "$line_count" >&2
  while IFS= read -r line; do
    printf '[ralph][%s] %s\n' "$tool_label" "$line" >&2
  done <<<"$excerpt"
}

validate_external_references_contract() {
  local story_id="$1"
  local last_message_file="$2"

  if [[ "$story_id" == "MODEL_PREFLIGHT" ]]; then
    return 0
  fi
  if [[ "$ENABLE_SEARCH" != "true" ]] || ! is_true "$REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH"; then
    return 0
  fi

  if ! grep -Eq '^##[[:space:]]+External References([[:space:]]*)$' "$last_message_file"; then
    log_event "WARN story=$story_id missing_external_references_section"
    return 41
  fi
  if ! grep -Eq '\[[^][]+\]\(https?://[^)]+\)|https?://[^[:space:])]+|www\.[^[:space:])]+' "$last_message_file"; then
    log_event "WARN story=$story_id missing_external_reference_links"
    return 42
  fi
  if ! grep -Eq '20[0-9]{2}-[0-9]{2}-[0-9]{2}' "$last_message_file"; then
    log_event "WARN story=$story_id missing_external_reference_dates"
    return 43
  fi

  return 0
}

run_codex_once() {
  local story_id="$1"
  local prompt_file="$2"
  local last_message_file="$3"
  local -a cmd
  local raw_codex_log
  local codex_rc
  local attempt=1
  local contract_rc
  local -a tool_env

  mapfile -t tool_env < <(build_tool_env)
  cmd=(env -i "CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${CODEX_INTERNAL_ORIGINATOR_OVERRIDE:-codex_cli_rs}" "${tool_env[@]}" codex -a never)
  if [[ "$ENABLE_SEARCH" == "true" ]]; then
    cmd+=(--search)
  fi

  cmd+=(exec -C "$REPO_ROOT" -s "$SANDBOX_MODE")

  if [[ -n "$REQUESTED_MODEL" ]]; then
    cmd+=(-m "$REQUESTED_MODEL")
  fi

  if [[ -n "$REASONING_EFFORT" ]]; then
    cmd+=(-c "model_reasoning_effort=\"$REASONING_EFFORT\"")
  fi

  cmd+=(--output-last-message "$last_message_file")

  while [[ "$attempt" -le "$MAX_ATTEMPTS_PER_STORY" ]]; do
    rm -f "$last_message_file"
    raw_codex_log="$(mktemp "$STATE_DIR/.codex-output.${story_id}.attempt${attempt}.XXXXXX")"
    register_tmp "$raw_codex_log"

    if run_with_timeout "${cmd[@]}" <"$prompt_file" >"$raw_codex_log" 2>&1; then
      codex_rc=0
    else
      codex_rc=$?
    fi

    if [[ "$codex_rc" -eq 0 ]] && [[ -s "$last_message_file" ]]; then
      contract_rc=0
      validate_external_references_contract "$story_id" "$last_message_file" || contract_rc=$?
      if [[ "$contract_rc" -eq 0 ]]; then
        if is_true "$CAPTURE_TOOL_OUTPUT"; then
          append_redacted_log "$raw_codex_log"
        fi
        if [[ "$attempt" -gt 1 ]]; then
          log_event "INFO story=$story_id tool_retry_recovered attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
        fi
        return 0
      fi
      codex_rc="$contract_rc"
    fi

    append_redacted_log "$raw_codex_log"
    if [[ "$codex_rc" -eq 0 ]] && [[ ! -s "$last_message_file" ]]; then
      codex_rc=44
      log_event "WARN story=$story_id empty_last_message attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
    fi

    if [[ "$attempt" -lt "$MAX_ATTEMPTS_PER_STORY" ]]; then
      log_event "WARN story=$story_id tool_attempt_failed rc=$codex_rc attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
      attempt=$((attempt + 1))
      sleep 1
      continue
    fi

    emit_redacted_tool_excerpt "$raw_codex_log" 25 "codex"
    return "$codex_rc"
  done
}

run_claude_once() {
  local story_id="$1"
  local prompt_file="$2"
  local last_message_file="$3"
  local -a cmd
  local raw_claude_log
  local claude_rc
  local attempt=1
  local contract_rc
  local permission_mode
  local -a tool_env

  mapfile -t tool_env < <(build_tool_env)
  cmd=(env -i "${tool_env[@]}" claude -p --output-format text --no-session-persistence)

  # Sandbox → permission mode mapping.
  # Override with RALPH_CLAUDE_PERMISSION_MODE if set.
  if [[ -n "${RALPH_CLAUDE_PERMISSION_MODE:-}" ]]; then
    permission_mode="$RALPH_CLAUDE_PERMISSION_MODE"
  else
    permission_mode="bypassPermissions"
  fi
  cmd+=(--permission-mode "$permission_mode")

  # For read-only sandbox, always disallow write-capable tools.
  if [[ "$SANDBOX_MODE" == "read-only" ]]; then
    cmd+=(--disallowedTools "Bash Edit Write NotebookEdit")
    if [[ -n "${RALPH_CLAUDE_PERMISSION_MODE:-}" ]]; then
      log_event "WARN story=$story_id readonly_claude_permission_override mode=$permission_mode"
    fi
  fi

  if [[ -n "$REQUESTED_MODEL" ]]; then
    cmd+=(--model "$REQUESTED_MODEL")
  fi

  if [[ -n "$REASONING_EFFORT" ]]; then
    cmd+=(--effort "$REASONING_EFFORT")
  fi

  if [[ "$ENABLE_SEARCH" == "true" ]]; then
    log_event "WARN story=$story_id claude_search_not_native (--search flag has no Claude CLI equivalent)"
  fi

  while [[ "$attempt" -le "$MAX_ATTEMPTS_PER_STORY" ]]; do
    rm -f "$last_message_file"
    raw_claude_log="$(mktemp "$STATE_DIR/.claude-output.${story_id}.attempt${attempt}.XXXXXX")"
    register_tmp "$raw_claude_log"

    # Claude CLI has no -C flag; run in subshell with cd.
    if (cd "$REPO_ROOT" && run_with_timeout "${cmd[@]}" <"$prompt_file" >"$last_message_file" 2>"$raw_claude_log"); then
      claude_rc=0
    else
      claude_rc=$?
    fi

    if [[ "$claude_rc" -eq 0 ]] && [[ -s "$last_message_file" ]]; then
      contract_rc=0
      validate_external_references_contract "$story_id" "$last_message_file" || contract_rc=$?
      if [[ "$contract_rc" -eq 0 ]]; then
        if is_true "$CAPTURE_TOOL_OUTPUT"; then
          append_redacted_log "$raw_claude_log"
        fi
        if [[ "$attempt" -gt 1 ]]; then
          log_event "INFO story=$story_id tool_retry_recovered attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
        fi
        return 0
      fi
      claude_rc="$contract_rc"
    fi

    append_redacted_log "$raw_claude_log"
    if [[ "$claude_rc" -eq 0 ]] && [[ ! -s "$last_message_file" ]]; then
      claude_rc=44
      log_event "WARN story=$story_id empty_last_message attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
    fi

    if [[ "$attempt" -lt "$MAX_ATTEMPTS_PER_STORY" ]]; then
      log_event "WARN story=$story_id tool_attempt_failed rc=$claude_rc attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
      attempt=$((attempt + 1))
      sleep 1
      continue
    fi

    emit_redacted_tool_excerpt "$raw_claude_log" 25 "claude"
    return "$claude_rc"
  done
}

run_tool_once() {
  local story_id="$1"
  local prompt_file="$2"
  local last_message_file="$3"

  case "$TOOL" in
  codex)
    run_codex_once "$story_id" "$prompt_file" "$last_message_file"
    ;;
  claude)
    run_claude_once "$story_id" "$prompt_file" "$last_message_file"
    ;;
  *)
    fail "Unsupported tool selected: $TOOL"
    ;;
  esac
}

maybe_run_model_preflight_check() {
  local prompt_file
  local last_message_file
  local codex_rc=0

  if ! is_true "$MODEL_PREFLIGHT"; then
    return
  fi

  prompt_file="$(mktemp "$STATE_DIR/.model-preflight.XXXXXX.md")"
  last_message_file="$(mktemp "$STATE_DIR/.model-preflight-last.XXXXXX.txt")"
  register_tmp "$prompt_file"
  register_tmp "$last_message_file"

  cat >"$prompt_file" <<'EOF'
Reply with exactly:
MODEL_PREFLIGHT_OK
EOF

  run_tool_once "MODEL_PREFLIGHT" "$prompt_file" "$last_message_file" || codex_rc=$?
  if [[ "$codex_rc" -ne 0 ]]; then
    fail "Model preflight check failed (tool=$TOOL model=$REQUESTED_MODEL rc=$codex_rc)"
  fi
  if ! grep -qx 'MODEL_PREFLIGHT_OK' "$last_message_file"; then
    fail "Model preflight check returned unexpected output for model=$REQUESTED_MODEL"
  fi

  log_event "INFO model_preflight_ok tool=$TOOL model=$REQUESTED_MODEL"
}
