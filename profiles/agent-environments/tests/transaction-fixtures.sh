#!/usr/bin/env bash
# Exercises profile installation and rollback only in disposable RAE-shaped targets.
set -euo pipefail
PROFILE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/rae-profile-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/target/scripts" "$fixture_root/target/.codex" "$fixture_root/target/.claude" "$fixture_root/target/docs"
printf '#!/usr/bin/env bash\nexit 0\n' > "$fixture_root/target/scripts/verify.sh"
managed=(.codex/config.toml .claude/settings.json docs/agent-operator-policy.md)
for target_file in "${managed[@]}"; do
  printf 'original %s\n' "$target_file" > "$fixture_root/target/$target_file"
done
"$BASH" "$PROFILE_ROOT/installers/install-profile.sh" --force "$fixture_root/target"
"${PYTHON_BIN:-python3}" -c 'import json,sys; assert json.load(open(sys.argv[1]))["manifest_version"] == 2' "$fixture_root/target/.rae-profile-install.json"
"$BASH" "$PROFILE_ROOT/installers/uninstall-profile.sh" "$fixture_root/target"
for target_file in "${managed[@]}"; do
  [[ "$(cat "$fixture_root/target/$target_file")" == "original $target_file" ]]
done
test ! -e "$fixture_root/target/.rae-profile-install.json"
for target_file in "${managed[@]}"; do
  test ! -e "$fixture_root/target/.rae-profile-backups/$target_file.bak"
done
mkdir -p "$fixture_root/rollback/scripts" "$fixture_root/hooks"
cp "$fixture_root/target/scripts/verify.sh" "$fixture_root/rollback/scripts/verify.sh"
touch "$fixture_root/hooks/install-after-files.continue"
if RAE_PROFILE_TEST_PAUSE_DIR="$fixture_root/hooks" RAE_PROFILE_TEST_FAIL_AFTER_PAUSE=install-after-files \
  "$BASH" "$PROFILE_ROOT/installers/install-profile.sh" "$fixture_root/rollback"; then
  printf 'FAIL: injected install failure succeeded\n' >&2
  exit 1
fi
for target_file in "${managed[@]}" .rae-profile-install.json; do
  test ! -e "$fixture_root/rollback/$target_file"
done
mkdir -p "$fixture_root/refusal/scripts" "$fixture_root/sentinel"
cp "$fixture_root/target/scripts/verify.sh" "$fixture_root/refusal/scripts/verify.sh"
printf 'preserve\n' > "$fixture_root/sentinel/config.toml"
ln -s "$fixture_root/sentinel" "$fixture_root/refusal/.codex"
if "$BASH" "$PROFILE_ROOT/installers/install-profile.sh" --force "$fixture_root/refusal"; then
  printf 'FAIL: symlink target accepted\n' >&2
  exit 1
fi
[[ "$(cat "$fixture_root/sentinel/config.toml")" == preserve ]]
printf 'Profile transaction fixtures passed\n'
