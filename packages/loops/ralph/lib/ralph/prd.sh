# shellcheck shell=bash

# Shared jq filter for open stories (mode matches, not passed, not skipped). Use with --arg mode "$MODE".
# shellcheck disable=SC2016
PRD_OPEN_STORY_SELECT='select(.mode == $mode and ((.passes // false) == false) and ((.skipped // false) == false))'

# Shared jq guard: verify exactly one story matches $id, or error. Use with --arg id "$story_id".
# shellcheck disable=SC2016,SC2034
PRD_STORY_BY_ID_GUARD='if ([.stories[] | select(.id == $id)] | length) != 1 then error("story id not found uniquely") else . end'

next_story_id() {
  jq -r --arg mode "$MODE" '
    [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' | { id: .id, priority: (.priority // 999999) } ]
    | sort_by(.priority, .id)
    | .[0].id // ""
  ' "$PRD_FILE"
}

remaining_count() {
  jq -r --arg mode "$MODE" '
    [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' ] | length
  ' "$PRD_FILE"
}

list_open_stories() {
  local format="${RALPH_LIST_STORIES_FORMAT:-full}"
  case "$format" in
    ids)
      jq -r --arg mode "$MODE" '
        [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' ]
        | sort_by(.priority, .id)
        | .[] | .id
      ' "$PRD_FILE" 2>/dev/null
      ;;
    id+title)
      jq -r --arg mode "$MODE" '
        [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' ]
        | sort_by(.priority, .id)
        | .[] | "\(.id)\t\(.title)"
      ' "$PRD_FILE" 2>/dev/null
      ;;
    json)
      jq -c --arg mode "$MODE" '
        [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' | {
            id,
            priority: (.priority // 999999),
            mode,
            title
          } ]
        | sort_by(.priority, .id)
      ' "$PRD_FILE" 2>/dev/null
      ;;
    *)
      jq -r --arg mode "$MODE" '
        [ .stories[] | '"$PRD_OPEN_STORY_SELECT"' ]
        | sort_by(.priority, .id)
        | .[] | "\(.id)\t\(.priority)\t\(.mode)\t\(.title)"
      ' "$PRD_FILE" 2>/dev/null
      ;;
  esac
}

load_story_cache() {
  local story_id="$1"
  local found_story="false"
  local count=0
  local key
  local value

  if [[ "$STORY_CACHE_ID" == "$story_id" ]]; then
    return
  fi

  STORY_CACHE_ID="$story_id"
  STORY_CACHE_TITLE=""
  STORY_CACHE_NOTES=""
  STORY_CACHE_OBJECTIVE=""
  STORY_CACHE_CREATED_LINE=""
  STORY_CACHE_SCOPE_PATTERNS=()
  STORY_CACHE_ACCEPTANCE_LINES=()
  STORY_CACHE_STEP_LINES=()
  STORY_CACHE_VERIFICATION_LINES=()
  STORY_CACHE_OUT_OF_SCOPE_LINES=()

  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    found_story="true"
    case "$key" in
      TITLE)
        STORY_CACHE_TITLE="$value"
        ;;
      NOTES)
        STORY_CACHE_NOTES="$value"
        ;;
      OBJECTIVE)
        STORY_CACHE_OBJECTIVE="$value"
        ;;
      SCOPE)
        STORY_CACHE_SCOPE_PATTERNS+=("$value")
        ;;
      AC)
        STORY_CACHE_ACCEPTANCE_LINES+=("$value")
        ;;
      STEP_LINE)
        STORY_CACHE_STEP_LINES+=("$value")
        ;;
      VERIFY)
        STORY_CACHE_VERIFICATION_LINES+=("$value")
        ;;
      OOS)
        STORY_CACHE_OUT_OF_SCOPE_LINES+=("$value")
        ;;
      CREATED)
        count=$((count + 1))
        if [[ "$count" -eq 1 ]]; then
          STORY_CACHE_CREATED_LINE="$value"
        fi
        ;;
    esac
  done < <(
    jq -rj --arg id "$story_id" --arg created_regex "$CREATED_AC_REGEX" '
      .stories[]
      | select(.id == $id)
      | "TITLE\u0000", (.title // ""), "\u0000"
      , "NOTES\u0000", (if (.notes | type) == "string" then .notes else "" end), "\u0000"
      , "OBJECTIVE\u0000", (if (.objective | type) == "string" then .objective else "" end), "\u0000"
      , (.scope[] | "SCOPE\u0000", ., "\u0000")
      , (.acceptance_criteria[] | "AC\u0000", ., "\u0000")
      , (
          (.steps // [])
          | to_entries[]
          | "STEP_LINE\u0000", ("Step " + ((.key + 1) | tostring) + " [" + (if (.value.id | type) == "string" and (.value.id | length) > 0 then .value.id else ("S" + ((.key + 1) | tostring)) end) + "]: " + .value.title), "\u0000"
          , (.value.actions[] | "STEP_LINE\u0000", ("  action: " + .), "\u0000")
          , (.value.expected_evidence[] | "STEP_LINE\u0000", ("  evidence: " + .), "\u0000")
          , (.value.done_when[] | "STEP_LINE\u0000", ("  done_when: " + .), "\u0000")
        )
      , ((.verification // [])[] | "VERIFY\u0000", ., "\u0000")
      , ((.out_of_scope // [])[] | "OOS\u0000", ., "\u0000")
      , (
          .acceptance_criteria[]
          | select(type == "string" and test($created_regex))
          | "CREATED\u0000", ., "\u0000"
        )
    ' "$PRD_FILE"
  )

  [[ "$found_story" == "true" ]] || fail "Story id not found in PRD: $story_id"

  if [[ "$count" -eq 0 ]]; then
    fail "Story $story_id has no acceptance criterion starting with 'Created '"
  fi
  if [[ "$count" -ne 1 ]]; then
    fail "Story $story_id has $count Created-lines; expected exactly one"
  fi
}

story_title() {
  local story_id="$1"
  load_story_cache "$story_id"
  printf '%s' "$STORY_CACHE_TITLE"
}

story_notes() {
  local story_id="$1"
  load_story_cache "$story_id"
  printf '%s' "$STORY_CACHE_NOTES"
}

story_objective() {
  local story_id="$1"
  load_story_cache "$story_id"
  printf '%s' "$STORY_CACHE_OBJECTIVE"
}

story_scope_lines() {
  local story_id="$1"
  local pattern

  load_story_cache "$story_id"
  for pattern in "${STORY_CACHE_SCOPE_PATTERNS[@]}"; do
    printf -- '%s%s%s\n' '- `' "$pattern" '`'
  done
}

story_step_lines() {
  local story_id="$1"
  local line

  load_story_cache "$story_id"
  for line in "${STORY_CACHE_STEP_LINES[@]}"; do
    if [[ "$line" == '  '* ]]; then
      printf '%s\n' "$line"
    else
      printf -- '- %s\n' "$line"
    fi
  done
}

story_verification_lines() {
  local story_id="$1"
  local line

  load_story_cache "$story_id"
  for line in "${STORY_CACHE_VERIFICATION_LINES[@]}"; do
    printf -- '- %s\n' "$line"
  done
}

story_out_of_scope_lines() {
  local story_id="$1"
  local line

  load_story_cache "$story_id"
  for line in "${STORY_CACHE_OUT_OF_SCOPE_LINES[@]}"; do
    printf -- '- %s\n' "$line"
  done
}

path_matches_story_scope() {
  local story_id="$1"
  local path="$2"
  local pattern glob
  local matched="false"
  local saw_positive="false"

  load_story_cache "$story_id"

  for pattern in "${STORY_CACHE_SCOPE_PATTERNS[@]}"; do
    [[ -n "$pattern" ]] || continue

    if [[ "$pattern" == \!* ]]; then
      glob="${pattern#!}"
      if path_matches_scope_glob "$glob" "$path"; then
        matched="false"
      fi
      continue
    fi

    saw_positive="true"
    if path_matches_scope_glob "$pattern" "$path"; then
      matched="true"
    fi
  done

  # If only negation patterns exist (no positive patterns), treat as implicit
  # match-all: everything matches except what was explicitly negated.
  if [[ "$saw_positive" == "false" && ${#STORY_CACHE_SCOPE_PATTERNS[@]} -gt 0 ]]; then
    matched="true"
  fi

  [[ "$matched" == "true" ]]
}

path_matches_scope_glob() {
  local pattern="$1"
  local path="$2"
  local glob alt_glob

  glob="${pattern#./}"
  # shellcheck disable=SC2254
  case "$path" in
    $glob) return 0 ;;
  esac

  # Treat **/foo as matching foo at repository root as well.
  if [[ "$glob" == '**/'* ]]; then
    alt_glob="${glob#'**/'}"
    if [[ -n "$alt_glob" ]]; then
      # shellcheck disable=SC2254
      case "$path" in
        $alt_glob) return 0 ;;
      esac
    fi
  fi

  return 1
}

story_acceptance_lines() {
  local story_id="$1"
  local line

  load_story_cache "$story_id"
  for line in "${STORY_CACHE_ACCEPTANCE_LINES[@]}"; do
    printf -- '- %s\n' "$line"
  done
}

extract_created_line() {
  local story_id="$1"

  load_story_cache "$story_id"
  printf '%s' "$STORY_CACHE_CREATED_LINE"
}

extract_report_path() {
  local created_line="$1"
  local rel

  rel="${created_line#Created }"
  rel="${rel%% *}"
  rel="${rel#\`}"
  rel="${rel%\`}"
  while [[ "$rel" == ./* ]]; do
    rel="${rel#./}"
  done

  [[ -n "$rel" ]] || fail "Could not parse report path from Created-line: $created_line"

  case "$rel" in
    /*)
      fail "Report path must be repository-relative, got absolute path: $rel"
      ;;
  esac

  case "$rel" in
    ../*|*/../*|..|*/..)
      fail "Report path must not traverse outside repository: $rel"
      ;;
  esac

  case "$rel" in
    *.md) ;;
    *) fail "Report path must end with .md: $rel" ;;
  esac

  if is_true "$STRICT_REPORT_DIR"; then
    if [[ -n "$DEFAULT_REPORT_DIR" ]]; then
      case "$rel" in
        "$DEFAULT_REPORT_DIR"/*) ;;
        *) fail "Report path must stay under defaults.report_dir ($DEFAULT_REPORT_DIR): $rel" ;;
      esac
    else
      fail "Strict report dir is enabled but defaults.report_dir is empty"
    fi
  fi

  # Do not clobber existing non-report files. In non-strict mode, new custom
  # paths are still allowed, but overwrites outside report_dir are blocked.
  if [[ -e "$REPO_ROOT/$rel" || -L "$REPO_ROOT/$rel" ]]; then
    if [[ -n "$DEFAULT_REPORT_DIR" ]]; then
      case "$rel" in
        "$DEFAULT_REPORT_DIR"/*) ;;
        *) fail "Refusing to overwrite existing non-report file: $rel" ;;
      esac
    elif ! is_true "$STRICT_REPORT_DIR"; then
      case "$rel" in
        audit/*|.claude/ralph-audit/audit/*) ;;
        *) fail "Refusing to overwrite existing non-report file: $rel" ;;
      esac
    fi
  fi

  printf '%s' "$rel"
}

is_path_within_root() {
  local root="$1"
  local abs_path="$2"
  [[ "$abs_path" == "$root" || "$abs_path" == "$root/"* ]]
}

resolve_effective_target_path() {
  local abs_target="$1"
  local probe="$abs_target"
  local suffix=""
  local segment parent resolved_probe

  while [[ ! -e "$probe" && ! -L "$probe" ]]; do
    segment="$(basename "$probe")"
    if [[ -z "$suffix" ]]; then
      suffix="$segment"
    else
      suffix="$segment/$suffix"
    fi
    parent="$(dirname "$probe")"
    [[ "$parent" != "$probe" ]] || return 1
    probe="$parent"
  done

  if [[ -d "$probe" ]]; then
    resolved_probe="$(cd "$probe" && pwd -P)" || return 1
  else
    parent="$(dirname "$probe")"
    segment="$(basename "$probe")"
    resolved_probe="$(cd "$parent" && pwd -P)/$segment" || return 1
  fi

  if [[ -n "$suffix" ]]; then
    printf '%s/%s' "$resolved_probe" "$suffix"
  else
    printf '%s' "$resolved_probe"
  fi
}

enforce_report_target_confinement() {
  local report_abs="$1"
  local report_rel="$2"
  local confinement_root="${3:-$REPO_ROOT_REAL}"
  local effective_target

  effective_target="$(resolve_effective_target_path "$report_abs")" || fail "Could not resolve report target path for: $report_rel"
  if ! is_path_within_root "$confinement_root" "$effective_target"; then
    fail "Report path resolves outside repository: $report_rel"
  fi
}
