# shellcheck shell=bash
# Bounded Codex execution, environment isolation, redaction, and report contract.

readonly RALPH_RAW_OUTPUT_LIMIT_BYTES=$((16 * 1024 * 1024))
readonly RALPH_REPORT_LIMIT_BYTES=$((2 * 1024 * 1024))
readonly -a CODEX_ENV_ALLOWLIST=(
  PATH HOME TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TERM COLORTERM NO_COLOR
  USER LOGNAME SHELL
  XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
  OPENAI_API_KEY CODEX_HOME
  HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY
  http_proxy https_proxy no_proxy all_proxy
  SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO
)

build_codex_env() {
  local target_name="$1"
  local var_name
  local -n target="$target_name"

  target=()
  for var_name in "${CODEX_ENV_ALLOWLIST[@]}"; do
    if [[ -v "$var_name" ]]; then
      target+=("$var_name=${!var_name}")
    fi
  done
  target+=(
    "PWD=$TOOL_REPO_ROOT"
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_cli_rs"
  )
}

append_redacted_log() {
  local raw_log_file="$1"
  redact_stream <"$raw_log_file" >>"$RUN_LOG"
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
  local excerpt
  excerpt="$(redact_stream <"$raw_log_file" | tail -n "$line_count" || true)"
  [[ -n "$excerpt" ]] || return

  printf '[ralph] codex failure excerpt (redacted, last %s lines):\n' "$line_count" >&2
  while IFS= read -r line; do
    printf '[ralph][codex] %s\n' "$line" >&2
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
}

run_codex_once() {
  local story_id="$1"
  local prompt_file="$2"
  local last_message_file="$3"
  local raw_codex_log codex_rc contract_rc
  local attempt=1
  local -a cmd codex_env

  build_codex_env codex_env
  cmd=(env -i "${codex_env[@]}" "$CODEX_EXECUTABLE" -a never)
  if [[ "$MODE" == "fixing" ]]; then
    cmd+=(-c 'sandbox_workspace_write.writable_roots=[]')
  fi
  if [[ "$ENABLE_SEARCH" == "true" ]]; then
    cmd+=(--search)
  fi
  cmd+=(exec -C "$TOOL_REPO_ROOT" -s "$SANDBOX_MODE")
  [[ -z "$REQUESTED_MODEL" ]] || cmd+=(-m "$REQUESTED_MODEL")
  [[ -z "$REASONING_EFFORT" ]] || cmd+=(-c "model_reasoning_effort=\"$REASONING_EFFORT\"")
  cmd+=(--output-last-message "$last_message_file")

  while [[ "$attempt" -le "$MAX_ATTEMPTS_PER_STORY" ]]; do
    rm -f "$last_message_file"
    raw_codex_log="$(mktemp "$STATE_DIR/.codex-output.${story_id}.attempt${attempt}.XXXXXX")"
    register_tmp "$raw_codex_log"

    if (
      cd "$TOOL_REPO_ROOT"
      "$PYTHON_EXECUTABLE" "$SCRIPT_DIR/scripts/ralph_supervisor.py" \
        --timeout "$RALPH_TIMEOUT_SECONDS" \
        --grace 15 \
        --raw-output "$raw_codex_log" \
        --report "$last_message_file" \
        --raw-limit "$RALPH_RAW_OUTPUT_LIMIT_BYTES" \
        --report-limit "$RALPH_REPORT_LIMIT_BYTES" \
        -- "${cmd[@]}" <"$prompt_file"
    ); then
      codex_rc=0
    else
      codex_rc=$?
    fi

    if [[ "$codex_rc" -eq 125 ]]; then
      log_event "WARN story=$story_id codex_output_overflow attempt=$attempt"
    elif [[ "$codex_rc" -eq 124 ]]; then
      log_event "WARN story=$story_id codex_deadline_exceeded attempt=$attempt"
    fi

    if [[ "$codex_rc" -eq 0 && -s "$last_message_file" ]]; then
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
    if [[ "$codex_rc" -eq 0 && ! -s "$last_message_file" ]]; then
      codex_rc=44
      log_event "WARN story=$story_id empty_last_message attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
    fi

    if [[ "$attempt" -lt "$MAX_ATTEMPTS_PER_STORY" ]]; then
      log_event "WARN story=$story_id tool_attempt_failed rc=$codex_rc attempt=$attempt max=$MAX_ATTEMPTS_PER_STORY"
      attempt=$((attempt + 1))
      sleep 1
      continue
    fi

    emit_redacted_tool_excerpt "$raw_codex_log" 25
    return "$codex_rc"
  done
}

run_tool_once() {
  run_codex_once "$@"
}

maybe_run_model_preflight_check() {
  local prompt_file last_message_file
  local codex_rc=0

  is_true "$MODEL_PREFLIGHT" || return 0
  prompt_file="$(mktemp "$STATE_DIR/.model-preflight.XXXXXX.md")"
  last_message_file="$(mktemp "$STATE_DIR/.model-preflight-last.XXXXXX.txt")"
  register_tmp "$prompt_file"
  register_tmp "$last_message_file"

  printf 'Reply with exactly:\nMODEL_PREFLIGHT_OK\n' >"$prompt_file"
  run_tool_once "MODEL_PREFLIGHT" "$prompt_file" "$last_message_file" || codex_rc=$?
  [[ "$codex_rc" -eq 0 ]] \
    || fail "Model preflight check failed (tool=codex model=$REQUESTED_MODEL rc=$codex_rc)"
  grep -qx 'MODEL_PREFLIGHT_OK' "$last_message_file" \
    || fail "Model preflight check returned unexpected output for model=$REQUESTED_MODEL"
  log_event "INFO model_preflight_ok tool=codex model=$REQUESTED_MODEL"
}
