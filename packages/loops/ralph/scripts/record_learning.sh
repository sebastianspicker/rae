#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/ralph/compat.sh
source "$ROOT_DIR/lib/ralph/compat.sh"
ralph_mktemp_init
# shellcheck source=scripts/lib/append_safe.sh
source "$SCRIPT_DIR/lib/append_safe.sh"
# shellcheck source=scripts/lib/parse_opts.sh
source "$SCRIPT_DIR/lib/parse_opts.sh"

OUT_FILE="$ROOT_DIR/learnings.md"
STORY_ID=""
NOTE=""
FILES=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/record_learning.sh --story <id> --note <text> [--files <csv>] [--out <path>]

Append one structured learning entry to learnings.md.

Options:
  --story <id>    Story identifier (e.g. AUDIT-001, FIX-002)
  --note <text>   Reusable learning note
  --files <csv>   Optional comma-separated related files
  --out <path>    Optional output file path (default: ./learnings.md)
  -h, --help      Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --story)
    [[ $# -ge 2 ]] || usage_exit "missing value for --story"
    STORY_ID="$2"
    shift 2
    ;;
  --note)
    [[ $# -ge 2 ]] || usage_exit "missing value for --note"
    NOTE="$2"
    shift 2
    ;;
  --files)
    [[ $# -ge 2 ]] || usage_exit "missing value for --files"
    FILES="$2"
    shift 2
    ;;
  --out)
    [[ $# -ge 2 ]] || usage_exit "missing value for --out"
    OUT_FILE="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    unknown_opt "$1"
    ;;
  esac
done

[[ -n "$STORY_ID" ]] || usage_exit "missing required --story"
[[ -n "$NOTE" ]] || usage_exit "missing required --note"

export RALPH_APPEND_ROOT="$ROOT_DIR"
content=""
if [[ ! -f "$OUT_FILE" ]]; then
  content+=$'# Ralph Learnings (Append-Only)\n\nThis file stores durable, reusable learnings across iterations.\nDo not rewrite history; append new entries only.\n\n## Codebase Patterns\n\n- Add stable cross-story patterns here (short bullets).\n\n## Learning Log\n\n<!-- Append entries below this line -->\n'
fi
content+="$(printf '\n### %s UTC | %s\n- Note: %s\n' "$(ralph_iso_utc)" "$STORY_ID" "$NOTE")"
[[ -z "$FILES" ]] || content="$content$(printf -- '- Files: %s\n' "$FILES")"
append_safe_to_file "$OUT_FILE" "$content"

printf 'Recorded learning in %s\n' "$OUT_FILE"
