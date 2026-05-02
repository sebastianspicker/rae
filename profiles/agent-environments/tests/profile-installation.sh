#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TARGET_DIR="$TMP_DIR/profile-target"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TARGET_DIR/scripts/verify.sh"
chmod +x "$TARGET_DIR/scripts/verify.sh"

bash "$ROOT_DIR/installers/install-profile.sh" "$TARGET_DIR" >/dev/null

test -f "$TARGET_DIR/.codex/config.toml"
test -f "$TARGET_DIR/.claude/settings.json"
test -f "$TARGET_DIR/docs/agent-operator-policy.md"
test -f "$TARGET_DIR/.rae-profile-install.json"

if rg -n "/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/|[0-9]{2}_(high|mid|low|hfmt|deprecated|archived)|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]" "$TARGET_DIR" >/dev/null 2>&1; then
  printf 'public profile payload contains forbidden private markers\n' >&2
  exit 1
fi

bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null

test ! -e "$TARGET_DIR/.codex/config.toml"
test ! -e "$TARGET_DIR/.claude/settings.json"
test ! -e "$TARGET_DIR/docs/agent-operator-policy.md"
test ! -e "$TARGET_DIR/.rae-profile-install.json"

NOOP_OUTPUT="$(bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR")"
if [[ "$NOOP_OUTPUT" != *'no installed profile found'* ]]; then
  printf 'uninstaller should report a truthful no-op when nothing is installed\n' >&2
  exit 1
fi

UNSUPPORTED_DIR="$TMP_DIR/unsupported-target"
mkdir -p "$UNSUPPORTED_DIR"
if bash "$ROOT_DIR/installers/install-profile.sh" "$UNSUPPORTED_DIR" >/dev/null 2>&1; then
  printf 'installer should reject unsupported non-RAE targets\n' >&2
  exit 1
fi

SYMLINK_TARGET="$TMP_DIR/symlink-target"
OUTSIDE_PROFILE_DIR="$TMP_DIR/outside-profile-dir"
mkdir -p "$SYMLINK_TARGET/scripts" "$OUTSIDE_PROFILE_DIR"
printf '#!/usr/bin/env bash\nexit 0\n' >"$SYMLINK_TARGET/scripts/verify.sh"
chmod +x "$SYMLINK_TARGET/scripts/verify.sh"
ln -s "$OUTSIDE_PROFILE_DIR" "$SYMLINK_TARGET/.codex"
if bash "$ROOT_DIR/installers/install-profile.sh" "$SYMLINK_TARGET" >/dev/null 2>&1; then
  printf 'installer should reject symlinked managed profile directories\n' >&2
  exit 1
fi
test ! -e "$OUTSIDE_PROFILE_DIR/config.toml"

TAMPER_TARGET="$TMP_DIR/tamper-target"
OUTSIDE_BACKUP="$TMP_DIR/outside-backup.txt"
mkdir -p "$TAMPER_TARGET/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TAMPER_TARGET/scripts/verify.sh"
chmod +x "$TAMPER_TARGET/scripts/verify.sh"
printf 'outside backup\n' >"$OUTSIDE_BACKUP"
python3 - "$TAMPER_TARGET/.rae-profile-install.json" <<'PY'
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
manifest_path.write_text(
    json.dumps(
        {
            "installer": "profiles/agent-environments/installers/install-profile.sh",
            "installed_files": [
                {
                    "path": ".codex/config.toml",
                    "sha256": "0" * 64,
                    "backup_path": "../outside-backup.txt",
                },
                {
                    "path": ".claude/settings.json",
                    "sha256": "1" * 64,
                    "backup_path": "",
                },
                {
                    "path": "docs/agent-operator-policy.md",
                    "sha256": "2" * 64,
                    "backup_path": "",
                },
            ],
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
if bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TAMPER_TARGET" >/dev/null 2>&1; then
  printf 'uninstaller should reject manifest backup path traversal\n' >&2
  exit 1
fi
test -f "$OUTSIDE_BACKUP"

mkdir -p "$TARGET_DIR/.codex" "$TARGET_DIR/.claude" "$TARGET_DIR/docs"
printf 'user codex\n' >"$TARGET_DIR/.codex/config.toml"
printf '{"user":true}\n' >"$TARGET_DIR/.claude/settings.json"
printf '# user policy\n' >"$TARGET_DIR/docs/agent-operator-policy.md"

if bash "$ROOT_DIR/installers/install-profile.sh" "$TARGET_DIR" >/dev/null 2>&1; then
  printf 'installer should refuse to overwrite existing files without --force\n' >&2
  exit 1
fi

if [[ "$(cat "$TARGET_DIR/.codex/config.toml")" != 'user codex' ]]; then
  printf 'installer modified existing codex config without --force\n' >&2
  exit 1
fi

bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null

test -f "$TARGET_DIR/.codex/config.toml"
test -f "$TARGET_DIR/.claude/settings.json"
test -f "$TARGET_DIR/docs/agent-operator-policy.md"

bash "$ROOT_DIR/installers/install-profile.sh" --force "$TARGET_DIR" >/dev/null
test -f "$TARGET_DIR/.rae-profile-install.json"
bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null

test -f "$TARGET_DIR/.codex/config.toml"
test -f "$TARGET_DIR/.claude/settings.json"
test -f "$TARGET_DIR/docs/agent-operator-policy.md"
test ! -e "$TARGET_DIR/.rae-profile-install.json"
[[ "$(cat "$TARGET_DIR/.codex/config.toml")" == 'user codex' ]]
[[ "$(cat "$TARGET_DIR/.claude/settings.json")" == '{"user":true}' ]]
[[ "$(cat "$TARGET_DIR/docs/agent-operator-policy.md")" == '# user policy' ]]

bash "$ROOT_DIR/installers/install-profile.sh" --force "$TARGET_DIR" >/dev/null
printf 'user modified\n' >"$TARGET_DIR/.codex/config.toml"
if bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null 2>&1; then
  printf 'uninstaller should refuse to remove modified installed files\n' >&2
  exit 1
fi

printf 'VERDICT: PASS\n'
