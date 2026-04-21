# shellcheck shell=bash
# shellcheck disable=SC2034

add_detected_check() {
  local entry="$1"
  local existing
  for existing in "${DETECTED_CHECKS[@]:-}"; do
    if [[ "$existing" == "$entry" ]]; then
      return
    fi
  done
  DETECTED_CHECKS+=("$entry")
}

pick_node_runner() {
  if [[ -f "$REPO_ROOT/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
    printf 'pnpm'
    return
  fi
  if [[ -f "$REPO_ROOT/yarn.lock" ]] && command -v yarn >/dev/null 2>&1; then
    printf 'yarn'
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    printf 'npm'
    return
  fi
  printf ''
}

find_makefile() {
  local f
  for f in "Makefile" "makefile" "GNUmakefile"; do
    if [[ -f "$REPO_ROOT/$f" ]]; then
      printf '%s' "$REPO_ROOT/$f"
      return
    fi
  done
  printf ''
}

collect_best_effort_checks() {
  if [[ "$DETECTED_CHECKS_READY" == "true" ]]; then
    return
  fi

  DETECTED_CHECKS=()

  local -a detection_order=()
  mapfile -t detection_order < <(jq -r '.defaults.lint_detection_order[]? // empty' "$PRD_FILE" 2>/dev/null || true)
  if [[ "${#detection_order[@]}" -eq 0 ]]; then
    detection_order=(
      "package.json scripts (lint/test)"
      "pyproject/requirements (ruff/pytest)"
      "go.mod"
      "Cargo.toml"
      "Makefile targets"
    )
  fi

  local detector
  for detector in "${detection_order[@]}"; do
    case "$detector" in
    "package.json scripts (lint/test)") detect_package_json_checks ;;
    "pyproject/requirements (ruff/pytest)") detect_python_checks ;;
    "go.mod") detect_go_checks ;;
    "Cargo.toml") detect_rust_checks ;;
    "Makefile targets") detect_make_checks ;;
    esac
  done

  DETECTED_CHECKS_READY="true"
}

detect_package_json_checks() {
  if [[ -f "$REPO_ROOT/package.json" ]]; then
    local runner lint_script test_script scripts_tsv
    runner="$(pick_node_runner)"
    scripts_tsv="$(jq -r '
      if (.scripts | type) == "object" then
        [
          (if (.scripts.lint | type) == "string" then .scripts.lint else "" end),
          (if (.scripts.test | type) == "string" then .scripts.test else "" end)
        ] | @tsv
      else
        "\t"
      end
    ' "$REPO_ROOT/package.json" 2>/dev/null || true)"
    [[ -n "$scripts_tsv" ]] || scripts_tsv=$'\t'
    IFS=$'\t' read -r lint_script test_script <<<"$scripts_tsv"

    if [[ -n "$runner" && -n "$lint_script" ]]; then
      if [[ "$runner" == "yarn" ]]; then
        add_detected_check "package.json::yarn lint"
      else
        add_detected_check "package.json::$runner run lint"
      fi
    fi

    if [[ -n "$runner" && -n "$test_script" ]]; then
      if [[ "$runner" == "yarn" ]]; then
        add_detected_check "package.json::yarn test"
      else
        add_detected_check "package.json::$runner run test"
      fi
    fi
  fi
}

detect_python_checks() {
  if [[ -f "$REPO_ROOT/pyproject.toml" || -f "$REPO_ROOT/requirements.txt" || -f "$REPO_ROOT/requirements-dev.txt" ]]; then
    if command -v ruff >/dev/null 2>&1; then
      add_detected_check "python::ruff check ."
    elif command -v python3 >/dev/null 2>&1; then
      add_detected_check "python::python3 -m ruff check ."
    fi

    if command -v pytest >/dev/null 2>&1; then
      add_detected_check "python::pytest -q"
    elif command -v python3 >/dev/null 2>&1; then
      add_detected_check "python::python3 -m pytest -q"
    fi
  fi
}

detect_go_checks() {
  if [[ -f "$REPO_ROOT/go.mod" ]] && command -v go >/dev/null 2>&1; then
    add_detected_check "go::go test ./..."
  fi
}

detect_rust_checks() {
  if [[ -f "$REPO_ROOT/Cargo.toml" ]] && command -v cargo >/dev/null 2>&1; then
    add_detected_check "rust::cargo test"
  fi
}

detect_make_checks() {
  local makefile
  makefile="$(find_makefile)"
  if [[ -n "$makefile" ]] && command -v make >/dev/null 2>&1; then
    if grep -Eq '^[[:space:]]*lint:' "$makefile"; then
      add_detected_check "make::make lint"
    fi
    if grep -Eq '^[[:space:]]*test:' "$makefile"; then
      add_detected_check "make::make test"
    fi
  fi
}

invalidate_detected_checks_cache() {
  DETECTED_CHECKS_READY="false"
  DETECTED_CHECKS=()
}

render_detected_checks() {
  if [[ "${#DETECTED_CHECKS[@]}" -eq 0 ]]; then
    printf '%s\n' "- No checks auto-detected. Report this explicitly and keep linting report valid."
    return
  fi

  local item source cmd
  for item in "${DETECTED_CHECKS[@]}"; do
    source="${item%%::*}"
    cmd="${item#*::}"
    printf -- "- [%s] command: %s\n" "$source" "$cmd"
  done
}

# Emit the story prompt body (everything except the policy file) to stdout.
_build_prompt_body() {
  local story_id="$1"
  local report_rel="$2"
  local title
  local notes
  local objective
  local today_utc

  title="$(story_title "$story_id")"
  notes="$(story_notes "$story_id")"
  objective="$(story_objective "$story_id")"
  today_utc="$(date -u '+%Y-%m-%d')"

  printf '# Ralph Story Run\n\n'
  printf 'Mode: %s\n' "$MODE"
  printf 'Story ID: %s\n' "$story_id"
  printf 'Title: %s\n' "$title"
  printf 'Output report path: %s\n' "$report_rel"
  printf 'Sandbox policy: %s\n\n' "$SANDBOX_MODE"
  printf "Today's UTC date: %s\n\n" "$today_utc"

  printf 'Scope patterns:\n'
  story_scope_lines "$story_id"
  printf '\n'

  printf 'Acceptance criteria:\n'
  story_acceptance_lines "$story_id"
  printf '\n'

  if [[ -n "$objective" ]]; then
    printf 'Story objective:\n%s\n\n' "$objective"
  fi

  if [[ "${#STORY_CACHE_STEP_LINES[@]}" -gt 0 ]]; then
    printf 'Execution steps (detailed):\n'
    story_step_lines "$story_id"
    printf '\n'
  fi

  if [[ "${#STORY_CACHE_VERIFICATION_LINES[@]}" -gt 0 ]]; then
    printf 'Verification checkpoints:\n'
    story_verification_lines "$story_id"
    printf '\n'
  fi

  if [[ "${#STORY_CACHE_OUT_OF_SCOPE_LINES[@]}" -gt 0 ]]; then
    printf 'Out of scope:\n'
    story_out_of_scope_lines "$story_id"
    printf '\n'
  fi

  if [[ -n "$notes" ]]; then
    printf 'Story notes:\n%s\n\n' "$notes"
  fi

  printf 'Mode guardrails:\n'
  case "$MODE" in
  audit)
    printf '%s\n' '- Read-only only. Do not modify repository files.'
    printf '%s\n' '- Produce a findings report with evidence and risk impact.'
    ;;
  linting)
    printf '%s\n' '- Read-only only. Do not modify repository files.'
    printf '%s\n' '- Run best-effort checks from detected commands; if none found, report that explicitly.'
    ;;
  fixing)
    printf '%s\n' '- Write is allowed, but keep fixes minimal, safe, and story-scoped.'
    printf '%s\n' '- No broad refactors, no architecture changes, no security/auth redesign.'
    if is_true "$REQUIRE_LEARNING_ENTRY_FOR_FIXING"; then
      printf '%s\n' "- This run requires at least one reusable entry in learnings.md for successful fixing stories."
    fi
    ;;
  esac
  printf '%s\n' '- Never print secrets, tokens, private keys, or raw .env values.'
  printf '\n'

  if [[ "$ENABLE_SEARCH" == "true" ]] && is_true "$REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH"; then
    printf 'External research contract:\n'
    printf '%s\n' "- Because web search is enabled, include a \`## External References\` section in the report."
    printf '%s\n' '- Add source links (absolute https URLs) for externally sourced claims.'
    printf '%s\n' '- Include accessed date(s) in ISO format (YYYY-MM-DD).'
    printf '\n'
  fi

  if [[ "$MODE" == "linting" || "$MODE" == "fixing" ]]; then
    collect_best_effort_checks
    printf 'Best-effort check command candidates (auto-detected):\n'
    render_detected_checks
    printf '\n'
  fi

  printf 'Output contract:\n'
  printf '%s\n' "- Return ONLY the final markdown report body for $report_rel"
  printf '%s\n' '- Do not include wrapper commentary before or after the markdown report.'
  printf '%s\n' '- Keep report deterministic, explicit, and evidence-based.'
}

# Build prompt with policy appended (used by tool adapters).
build_prompt() {
  local story_id="$1"
  local report_rel="$2"
  local prompt_file="$3"

  {
    _build_prompt_body "$story_id" "$report_rel"
    printf '\n%s\n\n' '---'
    cat "$POLICY_FILE"
  } >"$prompt_file"
}

# Build prompt WITHOUT policy (used by claude adapter; policy goes to --append-system-prompt).
build_prompt_without_policy() {
  local story_id="$1"
  local report_rel="$2"
  local prompt_file="$3"

  _build_prompt_body "$story_id" "$report_rel" >"$prompt_file"
}
