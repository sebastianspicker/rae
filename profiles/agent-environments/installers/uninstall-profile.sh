#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-}"

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

if [[ -z "$TARGET_DIR" ]]; then
  printf 'Usage: %s <target-dir>\n' "$0" >&2
  exit 2
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  printf 'no installed profile found in %s\n' "$TARGET_DIR"
  exit 0
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"
MANIFEST_PATH="$TARGET_DIR/.rae-profile-install.json"

reject_symlink_path() {
  local path="$1"
  if [[ -L "$path" ]]; then
    printf 'refusing to use symlinked profile path: %s\n' "$path" >&2
    exit 1
  fi
}

for path in \
  "$TARGET_DIR/.codex" \
  "$TARGET_DIR/.claude" \
  "$TARGET_DIR/docs" \
  "$TARGET_DIR/.rae-profile-backups" \
  "$TARGET_DIR/.rae-profile-backups/.codex" \
  "$TARGET_DIR/.rae-profile-backups/.claude" \
  "$TARGET_DIR/.rae-profile-backups/docs"; do
  reject_symlink_path "$path"
done

removed_any=false

if [[ -f "$MANIFEST_PATH" ]]; then
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required for uninstall-profile.sh\n' >&2
    exit 1
  }

  TMP_ENTRIES="$(mktemp)"
  trap 'rm -f "$TMP_ENTRIES"' EXIT
  python3 - "$MANIFEST_PATH" <<'PY' >"$TMP_ENTRIES"
import json
import re
import sys

expected_backup_paths = {
    ".codex/config.toml": ".rae-profile-backups/.codex/config.toml.bak",
    ".claude/settings.json": ".rae-profile-backups/.claude/settings.json.bak",
    "docs/agent-operator-policy.md": ".rae-profile-backups/docs/agent-operator-policy.md.bak",
}
expected_paths = set(expected_backup_paths)
sha256_re = re.compile(r"^[0-9a-f]{64}$")
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("installer") != "profiles/agent-environments/installers/install-profile.sh":
    raise SystemExit("invalid profile manifest installer")
entries = data.get("installed_files")
if not isinstance(entries, list) or len(entries) != len(expected_paths):
    raise SystemExit("invalid profile manifest installed_files")
seen = set()
for entry in entries:
    if not isinstance(entry, dict):
        raise SystemExit("invalid profile manifest entry")
    path = entry.get("path")
    sha256 = entry.get("sha256")
    backup_path = entry.get("backup_path", "")
    if not isinstance(path, str) or path not in expected_paths or path in seen:
        raise SystemExit("invalid profile manifest path")
    if not isinstance(sha256, str) or not sha256_re.match(sha256):
        raise SystemExit("invalid profile manifest sha256")
    if not isinstance(backup_path, str) or backup_path not in ("", expected_backup_paths[path]):
        raise SystemExit("invalid profile manifest backup_path")
    seen.add(path)
    print(f"{path}\t{sha256}\t{backup_path}")
PY

  while IFS=$'\t' read -r rel_path installed_sha backup_path; do
    target_path="$TARGET_DIR/$rel_path"
    if [[ -f "$target_path" ]]; then
      current_sha="$(sha256_file "$target_path")"
      if [[ "$current_sha" != "$installed_sha" ]]; then
        printf 'refusing to remove modified installed file: %s\n' "$target_path" >&2
        exit 1
      fi
    fi
  done <"$TMP_ENTRIES"

  while IFS=$'\t' read -r rel_path installed_sha backup_path; do
    target_path="$TARGET_DIR/$rel_path"
    if [[ -n "$backup_path" && -f "$TARGET_DIR/$backup_path" ]]; then
      mkdir -p "$(dirname "$target_path")"
      mv "$TARGET_DIR/$backup_path" "$target_path"
    else
      rm -f "$target_path"
    fi
    removed_any=true
  done <"$TMP_ENTRIES"

  rm -f "$MANIFEST_PATH"
  rmdir "$TARGET_DIR/.rae-profile-backups/.codex" 2>/dev/null || true
  rmdir "$TARGET_DIR/.rae-profile-backups/.claude" 2>/dev/null || true
  rmdir "$TARGET_DIR/.rae-profile-backups/docs" 2>/dev/null || true
  rmdir "$TARGET_DIR/.rae-profile-backups" 2>/dev/null || true
fi

rmdir "$TARGET_DIR/.codex" 2>/dev/null || true
rmdir "$TARGET_DIR/.claude" 2>/dev/null || true
rmdir "$TARGET_DIR/docs" 2>/dev/null || true

if [[ "$removed_any" == true ]]; then
  printf 'removed profile from %s\n' "$TARGET_DIR"
else
  printf 'no installed profile found in %s\n' "$TARGET_DIR"
fi
