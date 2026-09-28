# shellcheck shell=bash
# Shared PRD schema + jq filter validation. Used by lib/ralph/config.sh and tests.
# Call validate_prd_with_jq with: prd_file, schema_file, filter_file, supported_modes_json, created_regex.
# Returns 0 on success, 1 on failure (caller is responsible for fail/exit).

validate_prd_with_jq() {
  local prd_file="$1"
  local schema_file="$2"
  local filter_file="$3"
  local supported_modes_json="$4"
  local created_regex="$5"
  local required_defaults_keys required_story_keys
  local allowed_root_keys allowed_story_keys allowed_step_keys

  [[ -f "$prd_file" ]] || return 1
  [[ -f "$schema_file" ]] || return 1
  [[ -f "$filter_file" ]] || return 1

  required_defaults_keys="$(jq -c '."$defs".defaults.required // []' "$schema_file" 2>/dev/null || true)"
  required_story_keys="$(jq -c '."$defs".story.required // []' "$schema_file" 2>/dev/null || true)"
  allowed_root_keys="$(jq -c '.properties | keys // []' "$schema_file" 2>/dev/null || true)"
  allowed_story_keys="$(jq -c '."$defs".story.properties | keys // []' "$schema_file" 2>/dev/null || true)"
  allowed_step_keys="$(jq -c '."$defs".story_step.properties | keys // []' "$schema_file" 2>/dev/null || true)"

  [[ -n "$required_defaults_keys" && "$required_defaults_keys" != "null" ]] || return 1
  [[ -n "$required_story_keys" && "$required_story_keys" != "null" ]] || return 1
  [[ -n "$allowed_root_keys" && "$allowed_root_keys" != "null" ]] || return 1
  [[ -n "$allowed_story_keys" && "$allowed_story_keys" != "null" ]] || return 1
  [[ -n "$allowed_step_keys" && "$allowed_step_keys" != "null" ]] || return 1

  jq -e \
    --argjson supported_modes "$supported_modes_json" \
    --arg created_regex "$created_regex" \
    --argjson required_defaults_keys "$required_defaults_keys" \
    --argjson required_story_keys "$required_story_keys" \
    --argjson allowed_root_keys "$allowed_root_keys" \
    --argjson allowed_story_keys "$allowed_story_keys" \
    --argjson allowed_step_keys "$allowed_step_keys" \
    -f "$filter_file" \
    "$prd_file" >/dev/null
}

# On validation failure, emit a concrete diagnostic to stderr (first error found).
# Call with same args as validate_prd_with_jq; requires jq and schema files.
emit_prd_validation_diagnostic() {
  local prd_file="$1"
  local schema_file="$2"
  local supported_modes_json="$4"
  local created_regex="$5"
  local required_story_keys
  local msg

  required_story_keys="$(jq -c '."$defs".story.required // []' "$schema_file" 2>/dev/null || true)"
  msg="$(jq -r --arg created_regex "$created_regex" \
    --argjson required_story_keys "$required_story_keys" \
    --argjson supported_modes "$supported_modes_json" \
    '
      def created_count: [.acceptance_criteria[]? | select(test($created_regex))] | length;
      (if (.stories | length) == 0 then "PRD has no stories"
       elif ([.stories[].id] | length != (unique | length)) then "Duplicate story id(s) in .stories"
       else
         [.stories[]? | . as $s |
          (if ($s | .id | type != "string") then "Story with non-string or missing id"
           elif ($s.id | test("^(AUDIT|LINT|FIX)-[0-9]{3}$") | not) then "Story \($s.id): id must match (AUDIT|LINT|FIX)-NNN"
           elif ([$required_story_keys[] | select($s | has(.) | not)] | length) > 0 then "Story \($s.id): missing required field(s): " + ([$required_story_keys[] | select($s | has(.) | not)] | join(", "))
           elif ($s.scope | type) != "array" or ($s.scope | length) == 0 then "Story \($s.id): scope must be a non-empty array"
           elif ($s.acceptance_criteria | type) != "array" or ($s.acceptance_criteria | length) == 0 then "Story \($s.id): acceptance_criteria must be a non-empty array"
           elif ($s | created_count) != 1 then "Story \($s.id): acceptance_criteria must contain exactly one line matching Created ..."
           elif ($s.mode | . as $m | $supported_modes | index($m)) == null then "Story \($s.id): mode must be one of audit, linting, fixing"
           else empty end)]
        | first
       end
    ' "$prd_file" 2>/dev/null)"
  if [[ -n "$msg" && "$msg" != "null" ]]; then
    printf '[ralph] PRD diagnostic: %s\n' "$msg" >&2
  fi
}

# Call after validate_prd_structure; uses PRD_FILE and fail (from caller scope).
validate_prd_text_hygiene() {
  local bad_paths

  bad_paths="$(jq -r '
    def bad_text:
      test("[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]");
    [
      paths(strings) as $p
      | getpath($p) as $v
      | select($v | bad_text)
      | ($p | map(tostring) | join("."))
    ]
    | .[:5]
    | .[]
  ' "${PRD_FILE:?}" 2>/dev/null || true)"

  if [[ -n "$bad_paths" ]]; then
    fail "${RALPH_EXIT_PRD:-2}" "PRD contains disallowed hidden/control/bidi characters (first paths): $bad_paths" "Remove control/bidi characters from these paths in prd.json"
  fi
}
