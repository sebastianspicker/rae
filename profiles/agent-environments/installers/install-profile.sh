#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=false

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

usage() {
  printf 'Usage: %s [--force] <target-dir>\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --force)
    FORCE=true
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    break
    ;;
  esac
done

TARGET_DIR="${1:-}"
MANIFEST_PATH="$TARGET_DIR/.rae-profile-install.json"
BACKUP_ROOT="$TARGET_DIR/.rae-profile-backups"

if [[ -z "$TARGET_DIR" ]]; then
  usage
  exit 2
fi

if [[ ! -f "$TARGET_DIR/scripts/verify.sh" ]]; then
  printf 'unsupported target: expected an RAE-shaped repo with scripts/verify.sh at %s\n' "$TARGET_DIR" >&2
  exit 1
fi

for target in \
  "$TARGET_DIR/.codex/config.toml" \
  "$TARGET_DIR/.claude/settings.json" \
  "$TARGET_DIR/docs/agent-operator-policy.md"; do
  if [[ -e "$target" && "$FORCE" != true ]]; then
    printf 'refusing to overwrite existing file without --force: %s\n' "$target" >&2
    exit 1
  fi
done

command -v python3 >/dev/null 2>&1 || {
  printf 'python3 is required for install-profile.sh\n' >&2
  exit 1
}

mkdir -p "$TARGET_DIR/.codex" "$TARGET_DIR/.claude" "$TARGET_DIR/docs"

CODEx_BACKUP_PATH=""
CLAUDE_BACKUP_PATH=""
POLICY_BACKUP_PATH=""

if [[ -e "$TARGET_DIR/.codex/config.toml" ]]; then
  CODEx_BACKUP_PATH=".rae-profile-backups/.codex/config.toml.bak"
  mkdir -p "$BACKUP_ROOT/.codex"
  cp "$TARGET_DIR/.codex/config.toml" "$TARGET_DIR/$CODEx_BACKUP_PATH"
fi
if [[ -e "$TARGET_DIR/.claude/settings.json" ]]; then
  CLAUDE_BACKUP_PATH=".rae-profile-backups/.claude/settings.json.bak"
  mkdir -p "$BACKUP_ROOT/.claude"
  cp "$TARGET_DIR/.claude/settings.json" "$TARGET_DIR/$CLAUDE_BACKUP_PATH"
fi
if [[ -e "$TARGET_DIR/docs/agent-operator-policy.md" ]]; then
  POLICY_BACKUP_PATH=".rae-profile-backups/docs/agent-operator-policy.md.bak"
  mkdir -p "$BACKUP_ROOT/docs"
  cp "$TARGET_DIR/docs/agent-operator-policy.md" "$TARGET_DIR/$POLICY_BACKUP_PATH"
fi

cp "$ROOT_DIR/templates/codex/config.toml" "$TARGET_DIR/.codex/config.toml"
cp "$ROOT_DIR/templates/claude/settings.json" "$TARGET_DIR/.claude/settings.json"
cp "$ROOT_DIR/shared/policy/operator-policy.md" "$TARGET_DIR/docs/agent-operator-policy.md"

CODEX_SHA="$(sha256_file "$TARGET_DIR/.codex/config.toml")"
CLAUDE_SHA="$(sha256_file "$TARGET_DIR/.claude/settings.json")"
POLICY_SHA="$(sha256_file "$TARGET_DIR/docs/agent-operator-policy.md")"

python3 - "$MANIFEST_PATH" \
  "$CODEX_SHA" "$CODEx_BACKUP_PATH" \
  "$CLAUDE_SHA" "$CLAUDE_BACKUP_PATH" \
  "$POLICY_SHA" "$POLICY_BACKUP_PATH" <<'PY'
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
entries = [
    {
        "path": ".codex/config.toml",
        "sha256": sys.argv[2],
        "backup_path": sys.argv[3],
    },
    {
        "path": ".claude/settings.json",
        "sha256": sys.argv[4],
        "backup_path": sys.argv[5],
    },
    {
        "path": "docs/agent-operator-policy.md",
        "sha256": sys.argv[6],
        "backup_path": sys.argv[7],
    },
]
manifest_path.write_text(
    json.dumps(
        {
            "installer": "profiles/agent-environments/installers/install-profile.sh",
            "installed_files": entries,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY

printf 'installed profile into %s\n' "$TARGET_DIR"
