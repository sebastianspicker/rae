#!/usr/bin/env bash
# Install git hooks from scripts/hooks/ into .git/hooks/.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DEST="$REPO_ROOT/.git/hooks"

if [[ ! -d "$HOOKS_DEST" ]]; then
  echo "error: $HOOKS_DEST not found — are you inside a git repo?" >&2
  exit 1
fi

for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  dest="$HOOKS_DEST/$name"
  chmod +x "$hook"
  ln -sf "$hook" "$dest"
  echo "installed: $dest -> $hook"
done

echo "done"
