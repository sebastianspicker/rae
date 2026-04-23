#!/usr/bin/env bash
# shellcheck disable=SC2016

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/ralph/compat.sh
source "$ROOT_DIR/lib/ralph/compat.sh"
ralph_mktemp_init

PRD_FILE="${1:-$ROOT_DIR/prd.json}"
OUT_FILE="${2:-$ROOT_DIR/progress.txt}"

if [[ ! -f "$PRD_FILE" ]]; then
  printf 'missing prd file: %s\n' "$PRD_FILE" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || {
  printf 'missing dependency: jq\n' >&2
  exit 1
}

# shellcheck source=scripts/lib/prd_counts.sh
source "$SCRIPT_DIR/lib/prd_counts.sh"

OUT_DIR="$(dirname "$OUT_FILE")"
mkdir -p "$OUT_DIR"
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"

tmp_file="$(mktemp "$OUT_DIR_ABS/progress.XXXXXX.tmp")"
trap 'rm -f "$tmp_file"' EXIT

PRD_LABEL="$PRD_FILE"
if [[ "$PRD_LABEL" == "$ROOT_DIR/"* ]]; then
  PRD_LABEL="${PRD_LABEL#"$ROOT_DIR"/}"
fi

total_stories="$(prd_total_stories "$PRD_FILE")"
passed_stories="$(prd_passed_stories "$PRD_FILE")"
skipped_stories="$(prd_skipped_stories "$PRD_FILE")"
remaining_stories=$((total_stories - passed_stories - skipped_stories))

{
  printf '# Ralph Audit Progress (Generated)\n\n'
  printf 'Source of truth: `%s` (`stories[].passes`).\n' "$PRD_LABEL"
  printf 'This file is generated. Regenerate with: `./scripts/generate_progress.sh`.\n\n'
  printf 'Generated at (UTC): %s\n\n' "$(ralph_iso_utc)"

  printf '## Runtime Snapshot\n\n'
  printf -- '- Stories passed: `%s/%s`\n' "$passed_stories" "$total_stories"
  printf -- '- Stories skipped: `%s`\n' "$skipped_stories"
  printf -- '- Remaining: `%s`\n\n' "$remaining_stories"

  printf '## Mode Breakdown\n\n'
  jq -r '
    [.stories[]]
    | group_by(.mode)
    | sort_by(.[0].mode)
    | .[]
    | "- `\((.[0].mode))`: total=\(length), passed=\([.[] | select(.passes == true)] | length), skipped=\([.[] | select((.skipped // false) == true)] | length), remaining=\([.[] | select(.passes != true and ((.skipped // false) != true))] | length)"
  ' "$PRD_FILE"
  printf '\n'

  printf '## Story Status\n\n'
  jq -r '
    .stories
    | sort_by(.priority, .id)
    | .[]
    | "- [\((if .passes then "x" elif ((.skipped // false) == true) then "-" else " " end))] `\(.id)` (`\(.mode)`, priority=\(.priority), steps=\((.steps // []) | length)\(if ((.skipped // false) == true) then ", skipped" else "" end))"
  ' "$PRD_FILE"
} > "$tmp_file"

mv "$tmp_file" "$OUT_FILE"
