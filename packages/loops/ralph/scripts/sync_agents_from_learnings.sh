#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/parse_opts.sh
source "$SCRIPT_DIR/lib/parse_opts.sh"

ROOT_DIR_OVERRIDE=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/sync_agents_from_learnings.sh [--root <dir>]

Append latest learning note to AGENTS.md under "Learned Patterns" section if missing.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --root)
    [[ $# -ge 2 ]] || usage_exit "missing value for --root"
    ROOT_DIR_OVERRIDE="$2"
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

[[ -z "$ROOT_DIR_OVERRIDE" ]] || ROOT_DIR="$(cd "$ROOT_DIR_OVERRIDE" && pwd)"
# shellcheck source=lib/ralph/compat.sh
source "$ROOT_DIR/lib/ralph/compat.sh"
ralph_mktemp_init
# shellcheck source=scripts/lib/append_safe.sh
source "$SCRIPT_DIR/lib/append_safe.sh"

LEARNINGS="$ROOT_DIR/learnings.md"
AGENTS="$ROOT_DIR/AGENTS.md"

[[ -f "$LEARNINGS" ]] || exit 0
[[ -f "$AGENTS" ]] || exit 0

latest_note="$(
  awk '
    /^- Note: / { note=$0 }
    END { if (note != "") print note }
  ' "$LEARNINGS"
)"

[[ -n "$latest_note" ]] || exit 0

if awk -v note="$latest_note" '
  $0 == note { found=1; exit }
  END { exit(found ? 0 : 1) }
' "$AGENTS"; then
  exit 0
fi

if grep -q '^## Learned Patterns$' "$AGENTS"; then
  tmp_file="$(mktemp "${AGENTS}.XXXXXX.tmp")"
  trap 'rm -f "$tmp_file"' EXIT
  awk -v note="$latest_note" '
    { print }
    /^## Learned Patterns$/ { print ""; print note; inserted=1 }
    END {
      if (!inserted) {
        print "";
        print "## Learned Patterns";
        print "";
        print note;
      }
    }
  ' "$AGENTS" >"$tmp_file"
  mv "$tmp_file" "$AGENTS"
else
  content="$(printf '\n## Learned Patterns\n\n%s\n' "$latest_note")"
  export RALPH_APPEND_ROOT="$ROOT_DIR"
  append_safe_to_file "$AGENTS" "$content"
fi
