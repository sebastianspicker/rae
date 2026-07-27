#!/usr/bin/env bash
# Appends a validated progress event so Ralph history remains concise and append-only.

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

OUT_FILE="$ROOT_DIR/progress.log.md"
STORY_ID=""
MODE=""
TITLE=""
REPORT=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/append_progress_entry.sh --story <id> --mode <mode> --title <title> --report <path> [--out <file>]

Append one structured progress entry to progress.log.md.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --story)
    [[ $# -ge 2 ]] || usage_exit "missing value for --story"
    STORY_ID="$2"
    shift 2
    ;;
  --mode)
    [[ $# -ge 2 ]] || usage_exit "missing value for --mode"
    MODE="$2"
    shift 2
    ;;
  --title)
    [[ $# -ge 2 ]] || usage_exit "missing value for --title"
    TITLE="$2"
    shift 2
    ;;
  --report)
    [[ $# -ge 2 ]] || usage_exit "missing value for --report"
    REPORT="$2"
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
[[ -n "$MODE" ]] || usage_exit "missing required --mode"
[[ -n "$TITLE" ]] || usage_exit "missing required --title"
[[ -n "$REPORT" ]] || usage_exit "missing required --report"

export RALPH_APPEND_ROOT="$ROOT_DIR"
content=""
if [[ ! -f "$OUT_FILE" ]]; then
  content+=$'# Ralph Progress Log (Append-Only)\n\n## Codebase Patterns\n\n- Add reusable patterns here over time.\n\n## Entries\n'
fi
content+="$(printf '\n### %s UTC | %s\n- Mode: %s\n- Title: %s\n- Report: %s\n' "$(ralph_iso_utc)" "$STORY_ID" "$MODE" "$TITLE" "$REPORT")"
append_safe_to_file "$OUT_FILE" "$content"
