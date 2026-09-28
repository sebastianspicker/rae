#!/usr/bin/env bash
# Tests history transactions with local bare repositories and a network-free SSH transport.
set -euo pipefail
CLEANER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/rae-history-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT
export GIT_CONFIG_GLOBAL="$fixture_root/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
export GIT_ALLOW_PROTOCOL=ssh:file
export GIT_SSH_VARIANT=ssh
export GIT_SSH_COMMAND="$fixture_root/local-ssh"
cat > "$fixture_root/local-ssh" <<'TRANSPORT'
#!/usr/bin/env bash
# Resolve the fixture's two Git protocol commands locally without opening a socket.
set -euo pipefail
case "${*: -1}" in
  "git-upload-pack 'acme/demo'") exec git-upload-pack "$RAE_FIXTURE_BARE" ;;
  "git-receive-pack 'acme/demo'") exec git-receive-pack "$RAE_FIXTURE_BARE" ;;
  *) printf 'Unsupported fixture transport request\n' >&2; exit 1 ;;
esac
TRANSPORT
chmod +x "$fixture_root/local-ssh"
git config --global user.name 'Fixture Maintainer'
git config --global user.email 'maintainer@example.test'
git config --global commit.gpgsign false
git config --global init.defaultBranch main

seed() {
  local name="$1"
  export RAE_FIXTURE_BARE="$fixture_root/$name.git"
  git init --bare -q "$RAE_FIXTURE_BARE"
  git init -q "$fixture_root/$name"
  printf 'immutable tree\n' > "$fixture_root/$name/evidence.txt"
  git -C "$fixture_root/$name" add evidence.txt
  git -C "$fixture_root/$name" commit -q -m $'Fixture\n\nCo-authored-by: Pair Bot <pair@example.test>'
  git -C "$fixture_root/$name" remote add origin git@github.com:acme/demo
  git -C "$fixture_root/$name" push -q -u origin main
}

seed success
original_tree="$(git -C "$fixture_root/success" rev-parse 'HEAD^{tree}')"
"$BASH" "$CLEANER_ROOT/coauthor-trailer-cleaner.sh" --push --target 'Pair Bot <pair@example.test>' git@github.com:acme/demo "$fixture_root/success"
[[ "$(git -C "$fixture_root/success" rev-parse HEAD)" == "$(git --git-dir="$RAE_FIXTURE_BARE" rev-parse main)" ]]
[[ "$(git -C "$fixture_root/success" rev-parse 'HEAD^{tree}')" == "$original_tree" ]]
if git -C "$fixture_root/success" log -1 --format=%B | rg -q 'Co-authored-by:'; then
  printf 'FAIL: coauthor trailer survived rewrite\n' >&2
  exit 1
fi
[[ -z "$(git -C "$fixture_root/success" for-each-ref --format='%(refname)' refs/heads/backup refs/coauthor-trailer-cleaner)" ]]

seed rejected
original_oid="$(git -C "$fixture_root/rejected" rev-parse HEAD)"
printf '#!/usr/bin/env bash\nexit 1\n' > "$RAE_FIXTURE_BARE/hooks/pre-receive"
chmod +x "$RAE_FIXTURE_BARE/hooks/pre-receive"
if "$BASH" "$CLEANER_ROOT/coauthor-trailer-cleaner.sh" --push --target 'Pair Bot <pair@example.test>' git@github.com:acme/demo "$fixture_root/rejected"; then
  printf 'FAIL: rejected push succeeded\n' >&2
  exit 1
fi
[[ "$(git -C "$fixture_root/rejected" rev-parse HEAD)" == "$original_oid" ]]
[[ "$(git --git-dir="$RAE_FIXTURE_BARE" rev-parse main)" == "$original_oid" ]]
[[ "$(git -C "$fixture_root/rejected" for-each-ref --format='%(objectname)' refs/heads/backup)" == "$original_oid" ]]
[[ -n "$(git -C "$fixture_root/rejected" for-each-ref --format='%(objectname)' refs/coauthor-trailer-cleaner/transactions)" ]]

seed dirty
original_oid="$(git -C "$fixture_root/dirty" rev-parse HEAD)"
printf 'concurrent edit\n' >> "$fixture_root/dirty/evidence.txt"
if "$BASH" "$CLEANER_ROOT/coauthor-trailer-cleaner.sh" --no-push git@github.com:acme/demo "$fixture_root/dirty"; then
  printf 'FAIL: dirty checkout accepted\n' >&2
  exit 1
fi
[[ "$(git -C "$fixture_root/dirty" rev-parse HEAD)" == "$original_oid" ]]
[[ -z "$(git -C "$fixture_root/dirty" for-each-ref --format='%(refname)' refs/heads/backup refs/coauthor-trailer-cleaner)" ]]
printf 'History transaction fixtures passed\n'
