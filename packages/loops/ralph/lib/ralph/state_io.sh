# shellcheck shell=bash
# Story status import/export helpers (JSON).
# Sourced by ralph.sh; expects PRD_FILE, register_tmp(), fail(), log().

export_prd_state() {
  local ts
  local project_fingerprint story_ids_fingerprint story_definitions_fingerprint
  ts="$(ralph_iso_utc)"
  project_fingerprint="$(ralph_project_fingerprint)"
  story_ids_fingerprint="$(ralph_story_ids_fingerprint)"
  story_definitions_fingerprint="$(ralph_story_definitions_fingerprint)"
  jq -c --arg ts "$ts" \
    --arg project_fingerprint "$project_fingerprint" \
    --arg story_ids_fingerprint "$story_ids_fingerprint" \
    --arg story_definitions_fingerprint "$story_definitions_fingerprint" '
    {
      project: (.project // ""),
      project_fingerprint_sha256: $project_fingerprint,
      story_ids_fingerprint_sha256: $story_ids_fingerprint,
      story_definitions_fingerprint_sha256: $story_definitions_fingerprint,
      stories: [.stories[] | {
        id,
        passes,
        skipped: (.skipped == true),
        report_path: (.report_path // ""),
        completed_at: (.completed_at // ""),
        skip_reason: (.skip_reason // ""),
        skipped_at: (.skipped_at // "")
      }],
      exported_at: $ts
    }
  ' "$PRD_FILE"
}

import_prd_state() {
  local state_file="$1"
  local tmp project_fingerprint story_ids_fingerprint story_definitions_fingerprint old_prd_file
  [[ -f "$state_file" ]] || fail "State file not found: $state_file"
  jq -e '
    type == "object"
    and (.project | type == "string")
    and (.project_fingerprint_sha256 | type == "string" and length > 0)
    and (.story_ids_fingerprint_sha256 | type == "string" and length > 0)
    and (.story_definitions_fingerprint_sha256 | type == "string" and length > 0)
    and ((.stories // []) | type == "array")
    and (((.stories // []) | map(.id) | unique | length) == ((.stories // []) | length))
    and all((.stories // [])[];
      type == "object"
      and (.id | type == "string" and length > 0)
      and ((has("passes") | not) or (.passes | type == "boolean"))
      and ((has("skipped") | not) or (.skipped | type == "boolean"))
      and ((has("report_path") | not) or (.report_path | type == "string"))
      and ((has("completed_at") | not) or (.completed_at | type == "string"))
      and ((has("skip_reason") | not) or (.skip_reason | type == "string"))
      and ((has("skipped_at") | not) or (.skipped_at | type == "string"))
    )
  ' "$state_file" >/dev/null || fail "Invalid import-state payload: expected fingerprinted story status objects with unique ids and boolean/string fields only"

  project_fingerprint="$(ralph_project_fingerprint)"
  story_ids_fingerprint="$(ralph_story_ids_fingerprint)"
  story_definitions_fingerprint="$(ralph_story_definitions_fingerprint)"
  jq -e \
    --arg project_fingerprint "$project_fingerprint" \
    --arg story_ids_fingerprint "$story_ids_fingerprint" \
    --arg story_definitions_fingerprint "$story_definitions_fingerprint" '
    .project_fingerprint_sha256 == $project_fingerprint
    and .story_ids_fingerprint_sha256 == $story_ids_fingerprint
    and .story_definitions_fingerprint_sha256 == $story_definitions_fingerprint
  ' "$state_file" >/dev/null || fail "Import-state fingerprints do not match the current project/story definitions"

  tmp="$(mktemp "${PRD_FILE}.import.XXXXXX.json")"
  register_tmp "$tmp"
  jq --slurpfile state "$state_file" '
    ($state[0].stories // []) as $updates
    | .stories |= (
      map(. as $s | ($updates | map(select(.id == $s.id)) | .[0]) as $u
        | if $u then (
            ($s
              | if ($u | has("passes")) then .passes = $u.passes else . end
              | if ($u | has("skipped")) then .skipped = $u.skipped else . end
              | if ($u | has("report_path")) then .report_path = $u.report_path else . end
              | if ($u | has("completed_at")) then .completed_at = $u.completed_at else . end
              | if ($u | has("skip_reason")) then .skip_reason = $u.skip_reason else . end
              | if ($u | has("skipped_at")) then .skipped_at = $u.skipped_at else . end
            )
            | if (.passes != true) then del(.report_path, .completed_at) else . end
            | if ((.skipped // false) != true) then del(.skip_reason, .skipped_at) else . end
            | if ((.skipped | type) != "boolean") then del(.skipped) else . end
          ) else $s end)
    )
  ' "$PRD_FILE" >"$tmp" || fail "Import merge failed"

  old_prd_file="$PRD_FILE"
  PRD_FILE="$tmp"
  if ! validate_prd_with_jq "$PRD_FILE" "$PRD_SCHEMA_FILE" "$PRD_VALIDATE_FILTER_FILE" \
    "$SUPPORTED_MODES_JSON" "$CREATED_AC_REGEX"; then
    PRD_FILE="$old_prd_file"
    fail "Import produced invalid prd.json structure"
  fi
  validate_prd_text_hygiene
  PRD_FILE="$old_prd_file"

  mv "$tmp" "$PRD_FILE"
  log "Imported story state from $state_file"
}

ralph_hash_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
    return
  fi
  fail "No SHA-256 tool available (need shasum, sha256sum, or python3)"
}

ralph_project_fingerprint() {
  jq -cS '{project: (.project // "")}' "$PRD_FILE" | ralph_hash_stdin
}

ralph_story_ids_fingerprint() {
  jq -cS '[.stories[] | .id] | sort' "$PRD_FILE" | ralph_hash_stdin
}

ralph_story_definitions_fingerprint() {
  jq -cS '
    [
      .stories[]
      | {
          id,
          title,
          priority,
          mode,
          scope,
          acceptance_criteria,
          objective: (.objective // ""),
          steps: (.steps // []),
          verification: (.verification // []),
          out_of_scope: (.out_of_scope // []),
          notes: (.notes // "")
        }
    ]
    | sort_by(.id)
  ' "$PRD_FILE" | ralph_hash_stdin
}
