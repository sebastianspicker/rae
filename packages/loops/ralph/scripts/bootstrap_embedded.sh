#!/usr/bin/env bash
# Copies the Ralph template into a target repository so the loop can run as a self-contained tool.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/parse_opts.sh
source "$SCRIPT_DIR/lib/parse_opts.sh"

FORCE="false"
WITH_TESTS="false"
TARGET_REPO=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/bootstrap_embedded.sh [--force] [--with-tests] <target-repo>

Copies the golden ralph-audit template into:
  <target-repo>/.claude/ralph-audit

Options:
  --force       Overwrite existing destination contents.
  --with-tests  Also copy template regression tests.
  -h, --help    Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE="true"
      shift
      ;;
    --with-tests)
      WITH_TESTS="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$TARGET_REPO" ]]; then
        TARGET_REPO="$1"
        shift
      else
        unknown_opt "$1"
      fi
      ;;
  esac
done

if [[ -z "$TARGET_REPO" ]]; then
  usage_exit "missing required argument: <target-repo>"
fi
if [[ ! -d "$TARGET_REPO" ]]; then
  printf 'target repo does not exist: %s\n' "$TARGET_REPO" >&2
  exit 1
fi

TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"
CLAUDE_DIR="$TARGET_REPO/.claude"
DEST="$TARGET_REPO/.claude/ralph-audit"

if [[ -L "$CLAUDE_DIR" ]]; then
  printf '.claude must not be a symlink: %s\n' "$CLAUDE_DIR" >&2
  exit 1
fi
if [[ -e "$CLAUDE_DIR" && ! -d "$CLAUDE_DIR" ]]; then
  printf '.claude must be a directory: %s\n' "$CLAUDE_DIR" >&2
  exit 1
fi
if [[ -e "$DEST" && "$FORCE" != "true" ]]; then
  printf 'destination already exists: %s (use --force to overwrite)\n' "$DEST" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/lib/ralph" "$DEST/scripts/lib" "$DEST/skills/prd" "$DEST/skills/ralph"

copy_file() {
  local rel="$1"
  local src="$TEMPLATE_ROOT/$rel"
  local dst="$DEST/$rel"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_file "ralph.sh"
copy_file "INSTRUCTIONS.md"
copy_file "AGENTS.md"
copy_file "README.md"
copy_file "CONTRIBUTING.md"
copy_file "SECURITY.md"
copy_file "LICENSE"
copy_file "learnings.md"
copy_file "prd.json.example"
copy_file "prd.schema.json"
copy_file "prd.validate.jq"
copy_file "scripts/generate_progress.sh"
copy_file "scripts/record_learning.sh"
copy_file "scripts/archive_run_state.sh"
copy_file "scripts/append_progress_entry.sh"
copy_file "scripts/sync_agents_from_learnings.sh"
copy_file "scripts/ralph_supervisor.py"
copy_file "scripts/ralph_fs_txn.py"
copy_file "scripts/lib/parse_opts.sh"
copy_file "scripts/lib/append_safe.sh"
copy_file "scripts/lib/prd_counts.sh"
copy_file "skills/prd/SKILL.md"
copy_file "skills/ralph/SKILL.md"
copy_file "scripts/run_tests.sh"

for mod in "$TEMPLATE_ROOT"/lib/ralph/*.sh; do
  cp "$mod" "$DEST/lib/ralph/"
done

if [[ "$WITH_TESTS" == "true" ]]; then
  mkdir -p "$DEST/tests/lib"
  cp "$TEMPLATE_ROOT"/tests/*.sh "$DEST/tests/"
  cp "$TEMPLATE_ROOT"/tests/lib/*.sh "$DEST/tests/lib/"
fi

chmod +x "$DEST/ralph.sh" "$DEST/scripts/generate_progress.sh" "$DEST/scripts/record_learning.sh" "$DEST/scripts/archive_run_state.sh" "$DEST/scripts/append_progress_entry.sh" "$DEST/scripts/sync_agents_from_learnings.sh" "$DEST/scripts/ralph_supervisor.py" "$DEST/scripts/ralph_fs_txn.py" "$DEST/scripts/run_tests.sh"
if [[ "$WITH_TESTS" == "true" ]]; then
  chmod +x "$DEST"/tests/*.sh
fi

printf 'Bootstrapped template to %s\n' "$DEST"
