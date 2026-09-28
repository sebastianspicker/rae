#!/usr/bin/env bash
# Archives selected Ralph run state for inspection without mutating the active runtime record.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/ralph/compat.sh
source "$ROOT_DIR/lib/ralph/compat.sh"
# shellcheck source=scripts/lib/parse_opts.sh
source "$SCRIPT_DIR/lib/parse_opts.sh"

ARCHIVE_ROOT="$ROOT_DIR/archive"
REASON=""
LABEL=""
FORCE="false"

usage() {
  cat <<'USAGE'
Usage: ./scripts/archive_run_state.sh [--reason <text>] [--label <slug>] [--source-root <dir>] [--archive-root <dir>] [--force]

Archive current Ralph run state into a timestamped folder.

Archived when present:
  - prd.json
  - progress.txt
  - learnings.md
  - defaults.report_dir from prd.json

Options:
  --reason <text>       Optional reason metadata
  --label <slug>        Optional folder label suffix
  --source-root <dir>   Root containing prd/progress/learnings (default: template root)
  --archive-root <dir>  Archive root directory (default: ./archive)
  --force               Allow writing into an existing target directory
  -h, --help            Show this help
USAGE
}

slugify() {
  local s="$1"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
  s="$(printf '%s' "$s" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  [[ -n "$s" ]] || s="run"
  printf '%s' "$s"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-root)
      [[ $# -ge 2 ]] || usage_exit "missing value for --source-root"
      ROOT_DIR="$2"
      shift 2
      ;;
    --reason)
      [[ $# -ge 2 ]] || usage_exit "missing value for --reason"
      REASON="$2"
      shift 2
      ;;
    --label)
      [[ $# -ge 2 ]] || usage_exit "missing value for --label"
      LABEL="$2"
      shift 2
      ;;
    --archive-root)
      [[ $# -ge 2 ]] || usage_exit "missing value for --archive-root"
      ARCHIVE_ROOT="$2"
      shift 2
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      unknown_opt "$1"
      ;;
  esac
done

if [[ ! -d "$ROOT_DIR" ]]; then
  printf 'source root does not exist: %s\n' "$ROOT_DIR" >&2
  exit 1
fi
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"

# Resolve archive root to absolute path and ensure it is safe (non-empty, not root).
[[ -n "$ARCHIVE_ROOT" ]] || { printf 'archive root must not be empty\n' >&2; exit 1; }
if [[ ! -d "$ARCHIVE_ROOT" ]]; then
  mkdir -p "$ARCHIVE_ROOT" || { printf 'could not create archive root: %s\n' "$ARCHIVE_ROOT" >&2; exit 1; }
fi
ARCHIVE_ROOT="$(cd "$ARCHIVE_ROOT" && pwd)"
[[ "$ARCHIVE_ROOT" != "/" ]] || { printf 'archive root must not be filesystem root\n' >&2; exit 1; }

timestamp="$(ralph_iso_utc_compact)"
label_slug=""

if [[ -n "$LABEL" ]]; then
  label_slug="$(slugify "$LABEL")"
elif [[ -f "$ROOT_DIR/prd.json" ]] && command -v jq >/dev/null 2>&1; then
  detected_label="$(jq -r '.project // ""' "$ROOT_DIR/prd.json" 2>/dev/null || true)"
  if [[ -n "$detected_label" && "$detected_label" != "null" ]]; then
    label_slug="$(slugify "$detected_label")"
  fi
fi

if [[ -n "$label_slug" ]]; then
  target_dir="$ARCHIVE_ROOT/$timestamp-$label_slug"
else
  target_dir="$ARCHIVE_ROOT/$timestamp-run"
fi

# Ensure target_dir is strictly under ARCHIVE_ROOT (no path traversal).
[[ "$target_dir" == "$ARCHIVE_ROOT"/* ]] || {
  printf 'archive target path would escape archive root: %s\n' "$target_dir" >&2
  exit 1
}

if [[ -e "$target_dir" ]]; then
  if [[ "$FORCE" != "true" ]]; then
    printf 'archive target already exists: %s (use --force)\n' "$target_dir" >&2
    exit 1
  fi
  rm -rf "$target_dir"
fi

mkdir -p "$target_dir"

copy_if_present() {
  local rel="$1"
  local src="$ROOT_DIR/$rel"
  local dst="$target_dir/$rel"
  if [[ -e "$src" || -L "$src" ]]; then
    if [[ -d "$src" && ! -L "$src" ]]; then
      mkdir -p "$dst"
      cp -R "$src/." "$dst"
    else
      mkdir -p "$(dirname "$dst")"
      cp -R "$src" "$dst"
    fi
  fi
}

copy_if_present "prd.json"
copy_if_present "progress.txt"
copy_if_present "learnings.md"

if [[ -f "$ROOT_DIR/prd.json" ]] && command -v jq >/dev/null 2>&1; then
  report_dir="$(jq -r '.defaults.report_dir // ""' "$ROOT_DIR/prd.json" 2>/dev/null || true)"
  report_dir="${report_dir#./}"
  report_dir="${report_dir%/}"
  if [[ -n "$report_dir" && "$report_dir" != "null" ]]; then
    case "$report_dir" in
      *".."*|/*)
        printf '[ralph] skipping report_dir (unsafe path): %s\n' "$report_dir" >&2
        ;;
      *)
        copy_if_present "$report_dir"
        ;;
    esac
  fi
fi

{
  printf 'archived_at_utc=%s\n' "$(ralph_iso_utc)"
  if [[ -n "$REASON" ]]; then
    printf 'reason=%s\n' "$REASON"
  fi
  printf 'source_root=%s\n' "$ROOT_DIR"
} > "$target_dir/archive.meta"

printf 'Archived run state to %s\n' "$target_dir"
