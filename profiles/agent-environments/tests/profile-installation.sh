#!/usr/bin/env bash
# Exercises profile installation and recovery behavior across supported shell targets.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091 # Root is computed from this test entry point.
source "$ROOT_DIR/installers/runtime.sh"
rae_require_runtime
TMP_DIR="$(mktemp -d)"
TARGET_DIR="$TMP_DIR/profile-target"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

make_supported_target() {
  local target="$1"
  mkdir -p "$target/scripts"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$target/scripts/verify.sh"
  chmod +x "$target/scripts/verify.sh"
}

assert_profile_operations_reject() {
  local target="$1"
  local label="$2"
  if bash "$ROOT_DIR/installers/install-profile.sh" --force "$target" >/dev/null 2>&1; then
    printf 'installer should reject %s\n' "$label" >&2
    exit 1
  fi
  if bash "$ROOT_DIR/installers/uninstall-profile.sh" "$target" >/dev/null 2>&1; then
    printf 'uninstaller should reject %s\n' "$label" >&2
    exit 1
  fi
}

mkdir -p "$TARGET_DIR/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TARGET_DIR/scripts/verify.sh"
chmod +x "$TARGET_DIR/scripts/verify.sh"

bash "$ROOT_DIR/installers/install-profile.sh" "$TARGET_DIR" >/dev/null

test -f "$TARGET_DIR/.codex/config.toml"
test -f "$TARGET_DIR/.claude/settings.json"
test -f "$TARGET_DIR/docs/agent-operator-policy.md"
test -f "$TARGET_DIR/.rae-profile-install.json"
"$PYTHON_BIN" - "$TARGET_DIR" <<'PY'
import hashlib
import json
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
manifest = json.loads((target / ".rae-profile-install.json").read_text(encoding="utf-8"))
assert manifest["manifest_version"] == 2
assert len(manifest["installed_files"]) == 3
for entry in manifest["installed_files"]:
    installed = target / entry["path"]
    assert hashlib.sha256(installed.read_bytes()).hexdigest() == entry["sha256"]
    assert entry["backup_path"] == ""
    assert entry["backup_sha256"] == ""
PY

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

TARGET_DIR_SYMLINK="$TMP_DIR/target-dir-symlink"
ln -s "$TARGET_DIR" "$TARGET_DIR_SYMLINK"
assert_profile_operations_reject "$TARGET_DIR_SYMLINK" "a symlinked target directory"

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

SYMLINK_FILE_TARGET="$TMP_DIR/symlink-file-target"
OUTSIDE_PROFILE_FILE="$TMP_DIR/outside-profile-file"
mkdir -p "$SYMLINK_FILE_TARGET/scripts" "$SYMLINK_FILE_TARGET/.codex"
printf '#!/usr/bin/env bash\nexit 0\n' >"$SYMLINK_FILE_TARGET/scripts/verify.sh"
chmod +x "$SYMLINK_FILE_TARGET/scripts/verify.sh"
printf 'outside file\n' >"$OUTSIDE_PROFILE_FILE"
ln -s "$OUTSIDE_PROFILE_FILE" "$SYMLINK_FILE_TARGET/.codex/config.toml"
if bash "$ROOT_DIR/installers/install-profile.sh" --force "$SYMLINK_FILE_TARGET" >/dev/null 2>&1; then
  printf 'installer should reject symlinked managed profile files\n' >&2
  exit 1
fi
[[ "$(cat "$OUTSIDE_PROFILE_FILE")" == 'outside file' ]]

MANIFEST_SYMLINK_TARGET="$TMP_DIR/manifest-symlink-target"
OUTSIDE_MANIFEST="$TMP_DIR/outside-profile-manifest.json"
mkdir -p "$MANIFEST_SYMLINK_TARGET/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$MANIFEST_SYMLINK_TARGET/scripts/verify.sh"
chmod +x "$MANIFEST_SYMLINK_TARGET/scripts/verify.sh"
bash "$ROOT_DIR/installers/install-profile.sh" "$MANIFEST_SYMLINK_TARGET" >/dev/null
cp "$MANIFEST_SYMLINK_TARGET/.rae-profile-install.json" "$OUTSIDE_MANIFEST"
cp "$OUTSIDE_MANIFEST" "$TMP_DIR/outside-profile-manifest.before"
cp "$MANIFEST_SYMLINK_TARGET/.codex/config.toml" "$TMP_DIR/manifest-codex.before"
cp "$MANIFEST_SYMLINK_TARGET/.claude/settings.json" "$TMP_DIR/manifest-claude.before"
cp "$MANIFEST_SYMLINK_TARGET/docs/agent-operator-policy.md" "$TMP_DIR/manifest-policy.before"
rm "$MANIFEST_SYMLINK_TARGET/.rae-profile-install.json"
ln -s "$OUTSIDE_MANIFEST" "$MANIFEST_SYMLINK_TARGET/.rae-profile-install.json"
if bash "$ROOT_DIR/installers/install-profile.sh" --force "$MANIFEST_SYMLINK_TARGET" >/dev/null 2>&1; then
  printf 'installer should reject a symlinked profile manifest\n' >&2
  exit 1
fi
cmp -s "$OUTSIDE_MANIFEST" "$TMP_DIR/outside-profile-manifest.before"
cmp -s "$MANIFEST_SYMLINK_TARGET/.codex/config.toml" "$TMP_DIR/manifest-codex.before"
cmp -s "$MANIFEST_SYMLINK_TARGET/.claude/settings.json" "$TMP_DIR/manifest-claude.before"
cmp -s "$MANIFEST_SYMLINK_TARGET/docs/agent-operator-policy.md" "$TMP_DIR/manifest-policy.before"

TAMPER_TARGET="$TMP_DIR/tamper-target"
OUTSIDE_BACKUP="$TMP_DIR/outside-backup.txt"
mkdir -p "$TAMPER_TARGET/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TAMPER_TARGET/scripts/verify.sh"
chmod +x "$TAMPER_TARGET/scripts/verify.sh"
printf 'outside backup\n' >"$OUTSIDE_BACKUP"
"$PYTHON_BIN" - "$TAMPER_TARGET/.rae-profile-install.json" <<'PY'
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
manifest_path.write_text(
    json.dumps(
        {
            "manifest_version": 2,
            "installer": "profiles/agent-environments/installers/install-profile.sh",
            "installed_files": [
                {
                    "path": ".codex/config.toml",
                    "sha256": "0" * 64,
                    "backup_path": "../outside-backup.txt",
                    "backup_sha256": "3" * 64,
                },
                {
                    "path": ".claude/settings.json",
                    "sha256": "1" * 64,
                    "backup_path": "",
                    "backup_sha256": "",
                },
                {
                    "path": "docs/agent-operator-policy.md",
                    "sha256": "2" * 64,
                    "backup_path": "",
                    "backup_sha256": "",
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
if bash "$ROOT_DIR/installers/install-profile.sh" --force "$TAMPER_TARGET" >/dev/null 2>&1; then
  printf 'installer should reject manifest backup path traversal\n' >&2
  exit 1
fi
test -f "$OUTSIDE_BACKUP"

LEGACY_TARGET="$TMP_DIR/legacy-manifest-target"
make_supported_target "$LEGACY_TARGET"
"$PYTHON_BIN" - "$LEGACY_TARGET/.rae-profile-install.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(
    json.dumps(
        {
            "installer": "profiles/agent-environments/installers/install-profile.sh",
            "installed_files": [],
        }
    ),
    encoding="utf-8",
)
PY
assert_profile_operations_reject "$LEGACY_TARGET" "legacy manifest v1"

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
"$PYTHON_BIN" - "$TARGET_DIR" <<'PY'
import hashlib
import json
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
manifest = json.loads((target / ".rae-profile-install.json").read_text(encoding="utf-8"))
assert manifest["manifest_version"] == 2
for entry in manifest["installed_files"]:
    backup = target / entry["backup_path"]
    assert backup.is_file()
    assert hashlib.sha256(backup.read_bytes()).hexdigest() == entry["backup_sha256"]
PY
bash "$ROOT_DIR/installers/install-profile.sh" --force "$TARGET_DIR" >/dev/null
bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null

test -f "$TARGET_DIR/.codex/config.toml"
test -f "$TARGET_DIR/.claude/settings.json"
test -f "$TARGET_DIR/docs/agent-operator-policy.md"
test ! -e "$TARGET_DIR/.rae-profile-install.json"
[[ "$(cat "$TARGET_DIR/.codex/config.toml")" == 'user codex' ]]
[[ "$(cat "$TARGET_DIR/.claude/settings.json")" == '{"user":true}' ]]
[[ "$(cat "$TARGET_DIR/docs/agent-operator-policy.md")" == '# user policy' ]]

MISSING_BACKUP_TARGET="$TMP_DIR/missing-backup-target"
make_supported_target "$MISSING_BACKUP_TARGET"
mkdir -p "$MISSING_BACKUP_TARGET/.codex" "$MISSING_BACKUP_TARGET/.claude" "$MISSING_BACKUP_TARGET/docs"
printf 'original\n' >"$MISSING_BACKUP_TARGET/.codex/config.toml"
printf 'original\n' >"$MISSING_BACKUP_TARGET/.claude/settings.json"
printf 'original\n' >"$MISSING_BACKUP_TARGET/docs/agent-operator-policy.md"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$MISSING_BACKUP_TARGET" >/dev/null
rm "$MISSING_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
assert_profile_operations_reject "$MISSING_BACKUP_TARGET" "a missing original backup"

TAMPERED_BACKUP_TARGET="$TMP_DIR/tampered-backup-target"
make_supported_target "$TAMPERED_BACKUP_TARGET"
mkdir -p "$TAMPERED_BACKUP_TARGET/.codex"
printf 'original\n' >"$TAMPERED_BACKUP_TARGET/.codex/config.toml"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$TAMPERED_BACKUP_TARGET" >/dev/null
printf 'tampered\n' >"$TAMPERED_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
assert_profile_operations_reject "$TAMPERED_BACKUP_TARGET" "a tampered original backup"

SYMLINK_BACKUP_TARGET="$TMP_DIR/symlink-backup-target"
make_supported_target "$SYMLINK_BACKUP_TARGET"
mkdir -p "$SYMLINK_BACKUP_TARGET/.codex"
printf 'original\n' >"$SYMLINK_BACKUP_TARGET/.codex/config.toml"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$SYMLINK_BACKUP_TARGET" >/dev/null
rm "$SYMLINK_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
ln -s "$OUTSIDE_PROFILE_FILE" "$SYMLINK_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
assert_profile_operations_reject "$SYMLINK_BACKUP_TARGET" "a symlinked original backup"

NONREGULAR_BACKUP_TARGET="$TMP_DIR/nonregular-backup-target"
make_supported_target "$NONREGULAR_BACKUP_TARGET"
mkdir -p "$NONREGULAR_BACKUP_TARGET/.codex"
printf 'original\n' >"$NONREGULAR_BACKUP_TARGET/.codex/config.toml"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$NONREGULAR_BACKUP_TARGET" >/dev/null
rm "$NONREGULAR_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
mkdir "$NONREGULAR_BACKUP_TARGET/.rae-profile-backups/.codex/config.toml.bak"
assert_profile_operations_reject "$NONREGULAR_BACKUP_TARGET" "a non-regular original backup"

bash "$ROOT_DIR/installers/install-profile.sh" --force "$TARGET_DIR" >/dev/null
printf 'user modified\n' >"$TARGET_DIR/.codex/config.toml"
if bash "$ROOT_DIR/installers/uninstall-profile.sh" "$TARGET_DIR" >/dev/null 2>&1; then
  printf 'uninstaller should refuse to remove modified installed files\n' >&2
  exit 1
fi

wait_for_hook() {
  local hook_dir="$1"
  local hook_name="$2"
  local attempt
  for attempt in {1..500}; do
    : "$attempt"
    [[ -f "$hook_dir/$hook_name.ready" ]] && return 0
    sleep 0.01
  done
  printf 'timed out waiting for profile transaction hook %s\n' "$hook_name" >&2
  return 1
}

make_original_profile_target() {
  local target="$1"
  make_supported_target "$target"
  mkdir -p "$target/.codex" "$target/.claude" "$target/docs"
  printf 'original codex\n' >"$target/.codex/config.toml"
  printf '{"original":true}\n' >"$target/.claude/settings.json"
  printf '# original policy\n' >"$target/docs/agent-operator-policy.md"
}

assert_recovery() {
  local target="$1"
  find "$target" -maxdepth 2 -type f -path '*/.rae-profile-recovery-*/RECOVERY.json' \
    -print -quit | rg -q .
}

assert_recovery_and_quarantine() {
  local target="$1"
  local quarantine
  assert_recovery "$target"
  quarantine="$(find "$target" -type f \( -name '*.quarantine' -o -name '*.rollback' \) -print -quit)"
  [[ -n "$quarantine" ]]
}

assert_authoritative_recovery() {
  local target="$1"
  local expected_before="$2"
  local expected_installed="$3"
  local recovery
  recovery="$(find "$target" -maxdepth 1 -type d -name '.rae-profile-recovery-*' -print -quit)"
  [[ -n "$recovery" ]]
  cmp -s "$expected_before" "$recovery/before/.codex/config.toml"
  cmp -s "$expected_installed" "$recovery/installed/.codex/config.toml"
  assert_recovery_and_quarantine "$target"
}

INSTALL_BEFORE_TARGET="$TMP_DIR/install-before-replacement"
INSTALL_BEFORE_HOOK="$TMP_DIR/install-before-replacement-hook"
mkdir "$INSTALL_BEFORE_HOOK"
make_original_profile_target "$INSTALL_BEFORE_TARGET"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_BEFORE_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=install-before-replacement \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_BEFORE_TARGET" >/dev/null 2>&1 &
INSTALL_BEFORE_PID=$!
wait_for_hook "$INSTALL_BEFORE_HOOK" install-before-replacement
printf 'install before replacement competitor\n' >"$INSTALL_BEFORE_TARGET/.codex/config.toml"
touch "$INSTALL_BEFORE_HOOK/install-before-replacement.continue"
if wait "$INSTALL_BEFORE_PID"; then
  printf 'installer should reject a competitor immediately before replacement\n' >&2
  exit 1
fi
[[ "$(cat "$INSTALL_BEFORE_TARGET/.codex/config.toml")" == 'install before replacement competitor' ]]
assert_recovery_and_quarantine "$INSTALL_BEFORE_TARGET"

INSTALL_EDIT_TARGET="$TMP_DIR/install-concurrent-edit"
INSTALL_EDIT_HOOK="$TMP_DIR/install-concurrent-edit-hook"
mkdir "$INSTALL_EDIT_HOOK"
make_original_profile_target "$INSTALL_EDIT_TARGET"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_EDIT_HOOK" \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=install-after-files \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_EDIT_TARGET" >/dev/null 2>&1 &
INSTALL_EDIT_PID=$!
wait_for_hook "$INSTALL_EDIT_HOOK" install-after-files
printf 'concurrent install edit\n' >"$INSTALL_EDIT_TARGET/.codex/config.toml"
touch "$INSTALL_EDIT_HOOK/install-after-files.continue"
if wait "$INSTALL_EDIT_PID"; then
  printf 'installer should report rollback conflict after a concurrent edit\n' >&2
  exit 1
fi
[[ "$(cat "$INSTALL_EDIT_TARGET/.codex/config.toml")" == 'concurrent install edit' ]]
assert_recovery_and_quarantine "$INSTALL_EDIT_TARGET"

INSTALL_SWAP_TARGET="$TMP_DIR/install-swap-race"
INSTALL_SWAP_HOOK="$TMP_DIR/install-swap-race-hook"
INSTALL_SWAP_OUTSIDE="$TMP_DIR/install-swap-outside"
mkdir "$INSTALL_SWAP_HOOK" "$INSTALL_SWAP_OUTSIDE"
make_original_profile_target "$INSTALL_SWAP_TARGET"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_SWAP_HOOK" \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=install-after-replacement \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_SWAP_TARGET" >/dev/null 2>&1 &
INSTALL_SWAP_PID=$!
wait_for_hook "$INSTALL_SWAP_HOOK" install-after-replacement
mv "$INSTALL_SWAP_TARGET/.codex" "$INSTALL_SWAP_TARGET/.codex-swapped"
ln -s "$INSTALL_SWAP_OUTSIDE" "$INSTALL_SWAP_TARGET/.codex"
touch "$INSTALL_SWAP_HOOK/install-after-replacement.continue"
if wait "$INSTALL_SWAP_PID"; then
  printf 'installer should report rollback conflict after a directory swap\n' >&2
  exit 1
fi
test ! -e "$INSTALL_SWAP_OUTSIDE/config.toml"
assert_recovery "$INSTALL_SWAP_TARGET"

INSTALL_UNLINK_TARGET="$TMP_DIR/install-before-unlink"
INSTALL_UNLINK_HOOK="$TMP_DIR/install-before-unlink-hook"
mkdir "$INSTALL_UNLINK_HOOK"
make_original_profile_target "$INSTALL_UNLINK_TARGET"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_UNLINK_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=install-after-match-before-unlink \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_UNLINK_TARGET" >/dev/null 2>&1 &
INSTALL_UNLINK_PID=$!
wait_for_hook "$INSTALL_UNLINK_HOOK" install-after-match-before-unlink
printf 'install unlink competitor\n' >"$INSTALL_UNLINK_TARGET/.codex/config.toml"
touch "$INSTALL_UNLINK_HOOK/install-after-match-before-unlink.continue"
if wait "$INSTALL_UNLINK_PID"; then
  printf 'installer should reject a competitor after match and before unlink\n' >&2
  exit 1
fi
[[ "$(cat "$INSTALL_UNLINK_TARGET/.codex/config.toml")" == 'install unlink competitor' ]]
assert_recovery_and_quarantine "$INSTALL_UNLINK_TARGET"

UNINSTALL_BEFORE_TARGET="$TMP_DIR/uninstall-before-replacement"
UNINSTALL_BEFORE_HOOK="$TMP_DIR/uninstall-before-replacement-hook"
mkdir "$UNINSTALL_BEFORE_HOOK"
make_original_profile_target "$UNINSTALL_BEFORE_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_BEFORE_TARGET" >/dev/null
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_BEFORE_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=uninstall-before-replacement \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_BEFORE_TARGET" >/dev/null 2>&1 &
UNINSTALL_BEFORE_PID=$!
wait_for_hook "$UNINSTALL_BEFORE_HOOK" uninstall-before-replacement
printf 'uninstall before replacement competitor\n' >"$UNINSTALL_BEFORE_TARGET/.codex/config.toml"
touch "$UNINSTALL_BEFORE_HOOK/uninstall-before-replacement.continue"
if wait "$UNINSTALL_BEFORE_PID"; then
  printf 'uninstaller should reject a competitor immediately before replacement\n' >&2
  exit 1
fi
[[ "$(cat "$UNINSTALL_BEFORE_TARGET/.codex/config.toml")" == 'uninstall before replacement competitor' ]]
assert_recovery_and_quarantine "$UNINSTALL_BEFORE_TARGET"

UNINSTALL_EDIT_TARGET="$TMP_DIR/uninstall-concurrent-edit"
UNINSTALL_EDIT_HOOK="$TMP_DIR/uninstall-concurrent-edit-hook"
mkdir "$UNINSTALL_EDIT_HOOK"
make_original_profile_target "$UNINSTALL_EDIT_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_EDIT_TARGET" >/dev/null
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_EDIT_HOOK" \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=uninstall-after-files \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_EDIT_TARGET" >/dev/null 2>&1 &
UNINSTALL_EDIT_PID=$!
wait_for_hook "$UNINSTALL_EDIT_HOOK" uninstall-after-files
printf 'concurrent uninstall edit\n' >"$UNINSTALL_EDIT_TARGET/.codex/config.toml"
touch "$UNINSTALL_EDIT_HOOK/uninstall-after-files.continue"
if wait "$UNINSTALL_EDIT_PID"; then
  printf 'uninstaller should report rollback conflict after a concurrent edit\n' >&2
  exit 1
fi
[[ "$(cat "$UNINSTALL_EDIT_TARGET/.codex/config.toml")" == 'concurrent uninstall edit' ]]
assert_recovery_and_quarantine "$UNINSTALL_EDIT_TARGET"

UNINSTALL_SWAP_TARGET="$TMP_DIR/uninstall-swap-race"
UNINSTALL_SWAP_HOOK="$TMP_DIR/uninstall-swap-race-hook"
UNINSTALL_SWAP_OUTSIDE="$TMP_DIR/uninstall-swap-outside"
mkdir "$UNINSTALL_SWAP_HOOK" "$UNINSTALL_SWAP_OUTSIDE"
make_original_profile_target "$UNINSTALL_SWAP_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_SWAP_TARGET" >/dev/null
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_SWAP_HOOK" \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=uninstall-after-replacement \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_SWAP_TARGET" >/dev/null 2>&1 &
UNINSTALL_SWAP_PID=$!
wait_for_hook "$UNINSTALL_SWAP_HOOK" uninstall-after-replacement
mv "$UNINSTALL_SWAP_TARGET/.codex" "$UNINSTALL_SWAP_TARGET/.codex-swapped"
ln -s "$UNINSTALL_SWAP_OUTSIDE" "$UNINSTALL_SWAP_TARGET/.codex"
touch "$UNINSTALL_SWAP_HOOK/uninstall-after-replacement.continue"
if wait "$UNINSTALL_SWAP_PID"; then
  printf 'uninstaller should report rollback conflict after a directory swap\n' >&2
  exit 1
fi
test ! -e "$UNINSTALL_SWAP_OUTSIDE/config.toml"
assert_recovery "$UNINSTALL_SWAP_TARGET"

UNINSTALL_UNLINK_TARGET="$TMP_DIR/uninstall-before-unlink"
UNINSTALL_UNLINK_HOOK="$TMP_DIR/uninstall-before-unlink-hook"
mkdir "$UNINSTALL_UNLINK_HOOK"
make_original_profile_target "$UNINSTALL_UNLINK_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_UNLINK_TARGET" >/dev/null
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_UNLINK_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=uninstall-after-match-before-unlink \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_UNLINK_TARGET" >/dev/null 2>&1 &
UNINSTALL_UNLINK_PID=$!
wait_for_hook "$UNINSTALL_UNLINK_HOOK" uninstall-after-match-before-unlink
printf 'uninstall unlink competitor\n' >"$UNINSTALL_UNLINK_TARGET/.codex/config.toml"
touch "$UNINSTALL_UNLINK_HOOK/uninstall-after-match-before-unlink.continue"
if wait "$UNINSTALL_UNLINK_PID"; then
  printf 'uninstaller should reject a competitor after match and before unlink\n' >&2
  exit 1
fi
[[ "$(cat "$UNINSTALL_UNLINK_TARGET/.codex/config.toml")" == 'uninstall unlink competitor' ]]
assert_recovery_and_quarantine "$UNINSTALL_UNLINK_TARGET"

INSTALL_ROLLBACK_ALIAS_TARGET="$TMP_DIR/install-rollback-alias"
INSTALL_ROLLBACK_ALIAS_HOOK="$TMP_DIR/install-rollback-alias-hook"
INSTALL_ROLLBACK_ALIAS_BEFORE="$TMP_DIR/install-rollback-alias-before"
mkdir "$INSTALL_ROLLBACK_ALIAS_HOOK"
make_original_profile_target "$INSTALL_ROLLBACK_ALIAS_TARGET"
cp "$INSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml" "$INSTALL_ROLLBACK_ALIAS_BEFORE"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_ROLLBACK_ALIAS_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=rollback-after-hardlink-before-quarantine-unlink \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=install-after-files \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_ROLLBACK_ALIAS_TARGET" >/dev/null 2>&1 &
INSTALL_ROLLBACK_ALIAS_PID=$!
wait_for_hook "$INSTALL_ROLLBACK_ALIAS_HOOK" rollback-after-hardlink-before-quarantine-unlink
printf 'install rollback alias competitor\n' >"$INSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml"
touch "$INSTALL_ROLLBACK_ALIAS_HOOK/rollback-after-hardlink-before-quarantine-unlink.continue"
if wait "$INSTALL_ROLLBACK_ALIAS_PID"; then
  printf 'installer should reject a post-rollback-link alias mutation\n' >&2
  exit 1
fi
[[ "$(cat "$INSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml")" == 'install rollback alias competitor' ]]
assert_authoritative_recovery \
  "$INSTALL_ROLLBACK_ALIAS_TARGET" \
  "$INSTALL_ROLLBACK_ALIAS_BEFORE" \
  "$ROOT_DIR/templates/codex/config.toml"

UNINSTALL_ROLLBACK_ALIAS_TARGET="$TMP_DIR/uninstall-rollback-alias"
UNINSTALL_ROLLBACK_ALIAS_HOOK="$TMP_DIR/uninstall-rollback-alias-hook"
UNINSTALL_ROLLBACK_ALIAS_BEFORE="$TMP_DIR/uninstall-rollback-alias-before"
UNINSTALL_ROLLBACK_ALIAS_INSTALLED="$TMP_DIR/uninstall-rollback-alias-installed"
mkdir "$UNINSTALL_ROLLBACK_ALIAS_HOOK"
make_original_profile_target "$UNINSTALL_ROLLBACK_ALIAS_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_ROLLBACK_ALIAS_TARGET" >/dev/null
cp "$UNINSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml" "$UNINSTALL_ROLLBACK_ALIAS_BEFORE"
cp "$UNINSTALL_ROLLBACK_ALIAS_TARGET/.rae-profile-backups/.codex/config.toml.bak" \
  "$UNINSTALL_ROLLBACK_ALIAS_INSTALLED"
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_ROLLBACK_ALIAS_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=rollback-after-hardlink-before-quarantine-unlink \
  RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=uninstall-after-files \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_ROLLBACK_ALIAS_TARGET" >/dev/null 2>&1 &
UNINSTALL_ROLLBACK_ALIAS_PID=$!
wait_for_hook "$UNINSTALL_ROLLBACK_ALIAS_HOOK" rollback-after-hardlink-before-quarantine-unlink
printf 'uninstall rollback alias competitor\n' >"$UNINSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml"
touch "$UNINSTALL_ROLLBACK_ALIAS_HOOK/rollback-after-hardlink-before-quarantine-unlink.continue"
if wait "$UNINSTALL_ROLLBACK_ALIAS_PID"; then
  printf 'uninstaller should reject a post-rollback-link alias mutation\n' >&2
  exit 1
fi
[[ "$(cat "$UNINSTALL_ROLLBACK_ALIAS_TARGET/.codex/config.toml")" == 'uninstall rollback alias competitor' ]]
assert_authoritative_recovery \
  "$UNINSTALL_ROLLBACK_ALIAS_TARGET" \
  "$UNINSTALL_ROLLBACK_ALIAS_BEFORE" \
  "$UNINSTALL_ROLLBACK_ALIAS_INSTALLED"

INSTALL_COMMIT_ALIAS_TARGET="$TMP_DIR/install-commit-alias"
INSTALL_COMMIT_ALIAS_HOOK="$TMP_DIR/install-commit-alias-hook"
INSTALL_COMMIT_ALIAS_BEFORE="$TMP_DIR/install-commit-alias-before"
mkdir "$INSTALL_COMMIT_ALIAS_HOOK"
make_original_profile_target "$INSTALL_COMMIT_ALIAS_TARGET"
cp "$INSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml" "$INSTALL_COMMIT_ALIAS_BEFORE"
RAE_PROFILE_TEST_PAUSE_DIR="$INSTALL_COMMIT_ALIAS_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=install-commit-after-hardlink-before-quarantine-unlink \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/install-profile.sh" --force "$INSTALL_COMMIT_ALIAS_TARGET" >/dev/null 2>&1 &
INSTALL_COMMIT_ALIAS_PID=$!
wait_for_hook "$INSTALL_COMMIT_ALIAS_HOOK" install-commit-after-hardlink-before-quarantine-unlink
printf 'install commit alias competitor\n' >"$INSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml"
touch "$INSTALL_COMMIT_ALIAS_HOOK/install-commit-after-hardlink-before-quarantine-unlink.continue"
if wait "$INSTALL_COMMIT_ALIAS_PID"; then
  printf 'installer should reject a post-commit-link alias mutation\n' >&2
  exit 1
fi
[[ "$(cat "$INSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml")" == 'install commit alias competitor' ]]
assert_authoritative_recovery \
  "$INSTALL_COMMIT_ALIAS_TARGET" \
  "$INSTALL_COMMIT_ALIAS_BEFORE" \
  "$ROOT_DIR/templates/codex/config.toml"

UNINSTALL_COMMIT_ALIAS_TARGET="$TMP_DIR/uninstall-commit-alias"
UNINSTALL_COMMIT_ALIAS_HOOK="$TMP_DIR/uninstall-commit-alias-hook"
UNINSTALL_COMMIT_ALIAS_BEFORE="$TMP_DIR/uninstall-commit-alias-before"
UNINSTALL_COMMIT_ALIAS_INSTALLED="$TMP_DIR/uninstall-commit-alias-installed"
mkdir "$UNINSTALL_COMMIT_ALIAS_HOOK"
make_original_profile_target "$UNINSTALL_COMMIT_ALIAS_TARGET"
bash "$ROOT_DIR/installers/install-profile.sh" --force "$UNINSTALL_COMMIT_ALIAS_TARGET" >/dev/null
cp "$UNINSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml" "$UNINSTALL_COMMIT_ALIAS_BEFORE"
cp "$UNINSTALL_COMMIT_ALIAS_TARGET/.rae-profile-backups/.codex/config.toml.bak" \
  "$UNINSTALL_COMMIT_ALIAS_INSTALLED"
RAE_PROFILE_TEST_PAUSE_DIR="$UNINSTALL_COMMIT_ALIAS_HOOK" \
  RAE_PROFILE_TEST_PAUSE_AT=uninstall-commit-after-hardlink-before-quarantine-unlink \
  RAE_PROFILE_TEST_RELATIVE=.codex/config.toml \
  bash "$ROOT_DIR/installers/uninstall-profile.sh" "$UNINSTALL_COMMIT_ALIAS_TARGET" >/dev/null 2>&1 &
UNINSTALL_COMMIT_ALIAS_PID=$!
wait_for_hook "$UNINSTALL_COMMIT_ALIAS_HOOK" uninstall-commit-after-hardlink-before-quarantine-unlink
printf 'uninstall commit alias competitor\n' >"$UNINSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml"
touch "$UNINSTALL_COMMIT_ALIAS_HOOK/uninstall-commit-after-hardlink-before-quarantine-unlink.continue"
if wait "$UNINSTALL_COMMIT_ALIAS_PID"; then
  printf 'uninstaller should reject a post-commit-link alias mutation\n' >&2
  exit 1
fi
[[ "$(cat "$UNINSTALL_COMMIT_ALIAS_TARGET/.codex/config.toml")" == 'uninstall commit alias competitor' ]]
assert_authoritative_recovery \
  "$UNINSTALL_COMMIT_ALIAS_TARGET" \
  "$UNINSTALL_COMMIT_ALIAS_BEFORE" \
  "$UNINSTALL_COMMIT_ALIAS_INSTALLED"

printf 'VERDICT: PASS\n'
