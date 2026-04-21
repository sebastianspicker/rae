#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_json_event_escape_case() {
  local tmpdir stderr_file rc
  tmpdir="$(mktemp -d)"
  stderr_file="$tmpdir/stderr.log"

  set +e
  (
    # shellcheck source=lib/ralph/compat.sh
    source "$ROOT_DIR/lib/ralph/compat.sh"
    # shellcheck source=lib/ralph/core.sh
    source "$ROOT_DIR/lib/ralph/core.sh"
    # shellcheck source=lib/ralph/lock.sh
    source "$ROOT_DIR/lib/ralph/lock.sh"

    RALPH_OUTPUT_FORMAT="json"
    EVENT_LOG=""

    log_event $'WARN line1\nline2\ttab'
  ) 2> "$stderr_file"
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "json-event-escape" "expected success, got rc=$rc" "$stderr_file" "$tmpdir"
  fi

  if ! jq -e '.event == "WARN" and .msg == "line1\nline2\ttab"' "$stderr_file" >/dev/null; then
    fail_case "json-event-escape" "event JSON output is not valid or escaped correctly" "$stderr_file" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [json-event-escape]\n'
}

run_json_event_escape_case
printf 'All JSON event escape tests passed.\n'
