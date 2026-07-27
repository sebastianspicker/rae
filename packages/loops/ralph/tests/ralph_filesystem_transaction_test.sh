#!/usr/bin/env bash
# Regression coverage for Ralph's isolated filesystem transaction contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds python3 mktemp git jq
helper="$ROOT_DIR/scripts/ralph_fs_txn.py"
tmpdir="$(mktemp -d)"
metadata_root="$(mktemp -d "$HOME/.ralph-fs-test.XXXXXX")"
chmod 700 "$metadata_root"
nested_metadata_root="$(mktemp -d "$HOME/.ralph-fs-nested-temp-test.XXXXXX")"
chmod 700 "$nested_metadata_root"
mkdir -m 700 "$nested_metadata_root/transactions"

canonical_dir() {
  (cd "$1" && pwd -P)
}

make_tree_writable() {
  python3 - "$@" <<'PY'
import os
import stat
import sys

for root in sys.argv[1:]:
    if not os.path.isdir(root):
        continue
    for current, directories, _files in os.walk(root, topdown=True, followlinks=False):
        os.chmod(current, stat.S_IMODE(os.lstat(current).st_mode) | 0o700)
        for directory in directories:
            child = os.path.join(current, directory)
            if not os.path.islink(child):
                os.chmod(child, stat.S_IMODE(os.lstat(child).st_mode) | 0o700)
PY
}

make_repo() {
  local repo="$1"
  mkdir -p "$repo/.runtime" "$repo/bin"
  printf 'baseline\n' >"$repo/scoped.txt"
  printf 'human baseline\n' >"$repo/human.txt"
  printf '#!/bin/sh\n' >"$repo/bin/tool"
  chmod 751 "$repo/bin/tool"
  ln -s scoped.txt "$repo/link"
}

begin_txn() {
  local repo="$1"
  local root runtime pointer
  root="$(canonical_dir "$repo")"
  runtime="$(canonical_dir "$repo/.runtime")"
  pointer="$(pointer_for_repo "$repo")"
  python3 "$helper" mirror \
    --root "$root" --runtime "$runtime" --metadata-root "$metadata_root" \
    --pointer "$pointer"
}

pointer_for_repo() {
  local repo="$1"
  local root runtime
  root="$(canonical_dir "$repo")"
  runtime="$(canonical_dir "$repo/.runtime")"
  python3 "$helper" pointer-path \
    --root "$root" --runtime "$runtime" --metadata-root "$metadata_root"
}

txn_command() {
  local command="$1"
  local repo="$2"
  local journal="$3"
  shift 3
  local root runtime pointer
  root="$(canonical_dir "$repo")"
  runtime="$(canonical_dir "$repo/.runtime")"
  pointer="$(pointer_for_repo "$repo")"
  python3 "$helper" "$command" \
    --root "$root" --runtime "$runtime" --metadata-root "$metadata_root" \
    --pointer "$pointer" \
    --journal "$journal" "$@"
}

discard_txn() {
  txn_command discard "$1" "$2"
}

repo="$tmpdir/repo"
make_repo "$repo"
temp_metadata="$tmpdir/provider-writable-metadata"
mkdir -m 700 "$temp_metadata"
if python3 "$helper" pointer-path \
  --root "$(canonical_dir "$repo")" \
  --runtime "$(canonical_dir "$repo/.runtime")" \
  --metadata-root "$(canonical_dir "$temp_metadata")" \
  >"$tmpdir/temp-metadata.out" 2>"$tmpdir/temp-metadata.err"; then
  fail_case "transaction-temp-metadata" "provider-writable temp metadata root was accepted" "$tmpdir/temp-metadata.err" "$tmpdir"
fi
if TMPDIR="$nested_metadata_root/transactions" python3 "$helper" pointer-path \
  --root "$(canonical_dir "$repo")" \
  --runtime "$(canonical_dir "$repo/.runtime")" \
  --metadata-root "$(canonical_dir "$nested_metadata_root")" \
  >"$tmpdir/nested-temp.out" 2>"$tmpdir/nested-temp.err"; then
  fail_case "transaction-nested-temp-metadata" "metadata containing the provider temp root was accepted" "$tmpdir/nested-temp.err" "$tmpdir"
fi
journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"

baseline_store="$(jq -r '.baseline_store' "$journal")"
case "$journal" in
  "$metadata_root"/*) ;;
  *) fail_case "transaction-metadata-boundary" "journal is outside runner metadata root" "$journal" "$tmpdir" ;;
esac
case "$baseline_store" in
  "$metadata_root"/*) ;;
  *) fail_case "transaction-metadata-boundary" "baseline is outside runner metadata root" "$journal" "$tmpdir" ;;
esac
case "$workspace" in
  "$metadata_root"/*) fail_case "transaction-metadata-boundary" "provider workspace overlaps metadata" "$journal" "$tmpdir" ;;
esac
[[ "$(dirname "$workspace")" != "$(dirname "$journal")" ]] \
  || fail_case "transaction-metadata-boundary" "provider workspace and metadata are siblings" "$journal" "$tmpdir"

# Exercise the same built-in workspace sandbox used by Codex when available.
if command -v codex >/dev/null 2>&1 && codex sandbox \
  -c 'sandbox_workspace_write.writable_roots=[]' \
  -P :workspace -C "$workspace" /usr/bin/true >/dev/null 2>&1; then
  journal_hash="$(git hash-object "$journal")"
  baseline_hash="$(git hash-object "$baseline_store/scoped.txt")"
  sandbox_marker="$workspace/sandbox-probe.log"
  provider_parent_probe="$(dirname "$workspace")/provider-parent-probe"
  # shellcheck disable=SC2016 # Positional parameters expand in the sandboxed child.
  if ! codex sandbox -c 'sandbox_workspace_write.writable_roots=[]' \
    -P :workspace -C "$workspace" /bin/sh -c '
      marker=$1
      journal=$2
      baseline=$3
      parent_probe=$4
      printf "started\n" >"$marker"
      if printf "provider journal poison\n" >"$journal"; then
        printf "journal-writable\n" >>"$marker"
        exit 91
      fi
      printf "journal-denied\n" >>"$marker"
      if printf "provider baseline poison\n" >"$baseline"; then
        printf "baseline-writable\n" >>"$marker"
        exit 92
      fi
      printf "baseline-denied\n" >>"$marker"
      printf "provider temp write\n" >"$parent_probe"
      printf "completed\n" >>"$marker"
    ' sandbox-probe "$sandbox_marker" "$journal" "$baseline_store/scoped.txt" \
      "$provider_parent_probe" >"$tmpdir/sandbox.out" 2>"$tmpdir/sandbox.err"; then
    fail_case "transaction-codex-sandbox" "Codex sandbox probe did not complete" "$tmpdir/sandbox.err" "$tmpdir"
  fi
  [[ "$journal_hash" == "$(git hash-object "$journal")" ]] \
    || fail_case "transaction-codex-sandbox" "Codex sandbox changed the journal" "$tmpdir/sandbox.err" "$tmpdir"
  [[ "$baseline_hash" == "$(git hash-object "$baseline_store/scoped.txt")" ]] \
    || fail_case "transaction-codex-sandbox" "Codex sandbox changed the baseline" "$tmpdir/sandbox.err" "$tmpdir"
  [[ "$(cat "$sandbox_marker")" == $'started\njournal-denied\nbaseline-denied\ncompleted' ]] \
    || fail_case "transaction-codex-sandbox" "sandbox probe did not execute every denial check" "$sandbox_marker" "$tmpdir"
  [[ -f "$provider_parent_probe" ]] \
    || fail_case "transaction-codex-sandbox" "sandbox probe did not confirm writable temp parent" "$tmpdir/sandbox.err" "$tmpdir"
  printf 'PASS [codex-sandbox-metadata-boundary]\n'
else
  printf 'SKIP [codex-sandbox-metadata-boundary] codex sandbox unavailable\n'
fi

printf 'provider edit\n' >"$workspace/scoped.txt"
printf 'human concurrent edit\n' >"$repo/human.txt"
grep -q '^baseline$' "$repo/scoped.txt" \
  || fail_case "transaction-isolation" "provider changed the live checkout" "" "$tmpdir"
discard_txn "$repo" "$journal"
grep -q '^human concurrent edit$' "$repo/human.txt" \
  || fail_case "transaction-discard" "discard overwrote a concurrent human edit" "" "$tmpdir"

journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"
printf 'promoted edit\n' >"$workspace/scoped.txt"
printf 'unrelated human drift\n' >"$repo/human.txt"
txn_command prepare "$repo" "$journal"
txn_command verify "$repo" "$journal"
txn_command promote "$repo" "$journal"
grep -q '^promoted edit$' "$repo/scoped.txt" \
  || fail_case "transaction-promote" "scoped edit was not promoted" "" "$tmpdir"
grep -q '^unrelated human drift$' "$repo/human.txt" \
  || fail_case "transaction-promote" "unrelated live edit was not preserved" "" "$tmpdir"

# Directory additions, deletions, kind changes, final modes, and symlinks are
# promoted through the same quarantine and no-clobber protocol.
mkdir -p "$repo/replace-dir" "$repo/delete-dir/nested"
printf 'replace baseline\n' >"$repo/replace-dir/child.txt"
printf 'delete baseline\n' >"$repo/delete-dir/nested/child.txt"
printf 'file baseline\n' >"$repo/replace-file"
journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"
rm -r "$workspace/replace-dir"
ln -s scoped.txt "$workspace/replace-dir"
rm "$workspace/replace-file"
mkdir "$workspace/replace-file"
printf 'directory child\n' >"$workspace/replace-file/child.txt"
chmod 555 "$workspace/replace-file"
rm -r "$workspace/delete-dir"
mkdir "$workspace/new-readonly"
printf 'new child\n' >"$workspace/new-readonly/child.txt"
chmod 555 "$workspace/new-readonly"
rm "$workspace/link"
ln -s human.txt "$workspace/link"
txn_command prepare "$repo" "$journal"
txn_command promote "$repo" "$journal"
[[ -L "$repo/replace-dir" && "$(readlink "$repo/replace-dir")" == scoped.txt ]] \
  || fail_case "transaction-kind-promotion" "directory-to-symlink promotion failed" "" "$tmpdir"
[[ -d "$repo/replace-file" && -f "$repo/replace-file/child.txt" ]] \
  || fail_case "transaction-kind-promotion" "file-to-directory promotion failed" "" "$tmpdir"
[[ ! -e "$repo/delete-dir" ]] \
  || fail_case "transaction-directory-deletion" "non-empty directory deletion failed" "" "$tmpdir"
[[ -d "$repo/new-readonly" && -f "$repo/new-readonly/child.txt" ]] \
  || fail_case "transaction-directory-addition" "read-only directory addition failed" "" "$tmpdir"
python3 - "$repo/replace-file" "$repo/new-readonly" <<'PY'
import os
import stat
import sys

for value in sys.argv[1:]:
    assert stat.S_IMODE(os.lstat(value).st_mode) == 0o555
PY
[[ "$(readlink "$repo/link")" == human.txt ]] \
  || fail_case "transaction-symlink-promotion" "symlink target promotion failed" "" "$tmpdir"

journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"
printf 'provider replacement\n' >"$workspace/scoped.txt"
txn_command prepare "$repo" "$journal"
printf 'human same-path drift\n' >"$repo/scoped.txt"
set +e
txn_command verify "$repo" "$journal" >"$tmpdir/drift.out" 2>"$tmpdir/drift.err"
rc=$?
set -e
[[ "$rc" -eq 3 ]] \
  || fail_case "transaction-live-drift" "expected verify status 3, got $rc" "$tmpdir/drift.err" "$tmpdir"
discard_txn "$repo" "$journal"
grep -q '^human same-path drift$' "$repo/scoped.txt" \
  || fail_case "transaction-live-drift" "drift abort altered the human edit" "" "$tmpdir"

# Recovery restores only a path already recorded as promoted.
printf 'recovery baseline\n' >"$repo/scoped.txt"
printf 'recovery human baseline\n' >"$repo/human.txt"
journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"
printf 'interrupted provider edit\n' >"$workspace/scoped.txt"
txn_command prepare "$repo" "$journal"
encoded_scoped="$(python3 -c 'import base64; print(base64.urlsafe_b64encode(b"scoped.txt").decode())')"
printf 'interrupted provider edit\n' >"$repo/scoped.txt"
printf 'human edit during interruption\n' >"$repo/human.txt"
journal_tmp="$journal.tmp"
jq --arg path "$encoded_scoped" '.state="applying" | .promoted=[$path] | .active=null' "$journal" >"$journal_tmp"
chmod 600 "$journal_tmp"
mv "$journal_tmp" "$journal"
root="$(canonical_dir "$repo")"
runtime="$(canonical_dir "$repo/.runtime")"
python3 "$helper" recover --root "$root" --runtime "$runtime" \
  --metadata-root "$metadata_root" --pointer "$(pointer_for_repo "$repo")"
grep -q '^recovery baseline$' "$repo/scoped.txt" \
  || fail_case "transaction-recovery" "promoted path was not restored" "" "$tmpdir"
grep -q '^human edit during interruption$' "$repo/human.txt" \
  || fail_case "transaction-recovery" "recovery altered an unrelated human path" "" "$tmpdir"

# A symlinked pointer fails closed without following or replacing its target.
pointer_target="$tmpdir/pointer-target.json"
printf '{"sentinel":true}\n' >"$pointer_target"
pointer="$(pointer_for_repo "$repo")"
mkdir -p "$(dirname "$pointer")"
ln -s "$pointer_target" "$pointer"
if python3 "$helper" recover --root "$root" --runtime "$runtime" \
  --metadata-root "$metadata_root" --pointer "$pointer" >"$tmpdir/pointer.out" 2>"$tmpdir/pointer.err"; then
  fail_case "transaction-hostile-pointer" "symlinked pointer was accepted" "$tmpdir/pointer.err" "$tmpdir"
fi
jq -e '.sentinel == true' "$pointer_target" >/dev/null \
  || fail_case "transaction-hostile-pointer" "pointer target was changed" "$pointer_target" "$tmpdir"
rm "$pointer"

# A pointer copied into another runtime cannot redirect recovery to the first root.
journal="$(begin_txn "$repo")"
other_repo="$tmpdir/other-repo"
make_repo "$other_repo"
other_root="$(canonical_dir "$other_repo")"
other_runtime="$(canonical_dir "$other_repo/.runtime")"
pointer="$(pointer_for_repo "$repo")"
other_pointer="$(pointer_for_repo "$other_repo")"
cp "$pointer" "$other_pointer"
if python3 "$helper" recover --root "$other_root" --runtime "$other_runtime" \
  --metadata-root "$metadata_root" --pointer "$other_pointer" >"$tmpdir/wrong-root.out" 2>"$tmpdir/wrong-root.err"; then
  fail_case "transaction-wrong-root" "wrong-root pointer was accepted" "$tmpdir/wrong-root.err" "$tmpdir"
fi
discard_txn "$repo" "$journal"
rm "$other_pointer"

# Symlinked journal and mirror paths are rejected before use.
journal="$(begin_txn "$repo")"
mv "$journal" "$journal.saved"
ln -s "$journal.saved" "$journal"
if txn_command workspace "$repo" "$journal" >"$tmpdir/journal.out" 2>"$tmpdir/journal.err"; then
  fail_case "transaction-hostile-journal" "symlinked journal was accepted" "$tmpdir/journal.err" "$tmpdir"
fi
rm "$journal"
mv "$journal.saved" "$journal"
discard_txn "$repo" "$journal"

journal="$(begin_txn "$repo")"
workspace="$(txn_command workspace "$repo" "$journal")"
mv "$workspace" "$workspace.saved"
ln -s "$other_repo" "$workspace"
if txn_command workspace "$repo" "$journal" >"$tmpdir/mirror.out" 2>"$tmpdir/mirror.err"; then
  fail_case "transaction-hostile-mirror" "symlinked mirror was accepted" "$tmpdir/mirror.err" "$tmpdir"
fi
rm "$workspace"
mv "$workspace.saved" "$workspace"

# An escaping path in a hostile manifest is rejected before use.
escaping="$(python3 -c 'import base64; print(base64.urlsafe_b64encode(b"../escape").decode())')"
journal_tmp="$journal.tmp"
jq --arg path "$escaping" '.baseline[0].path=$path' "$journal" >"$journal_tmp"
chmod 600 "$journal_tmp"
mv "$journal_tmp" "$journal"
if txn_command workspace "$repo" "$journal" >"$tmpdir/manifest.out" 2>"$tmpdir/manifest.err"; then
  fail_case "transaction-escaping-manifest" "escaping manifest was accepted" "$tmpdir/manifest.err" "$tmpdir"
fi
rm -f "$(pointer_for_repo "$repo")"
make_tree_writable "$(dirname "$journal")" "$(dirname "$workspace")"
rm -rf "$(dirname "$journal")"
rm -rf "$(dirname "$workspace")"

snapshot="$tmpdir/snapshot.json"
python3 "$helper" snapshot --root "$root" --runtime "$runtime" --output "$snapshot"
jq -e '.format == 4 and (.entries | length > 0)' "$snapshot" >/dev/null \
  || fail_case "transaction-snapshot" "snapshot manifest is invalid" "$snapshot" "$tmpdir"

ln "$repo/scoped.txt" "$repo/hardlink"
if begin_txn "$repo" >"$tmpdir/hardlink.out" 2>"$tmpdir/hardlink.err"; then
  fail_case "transaction-hardlink" "hardlink was not rejected" "$tmpdir/hardlink.err" "$tmpdir"
fi
grep -q 'hard-linked file is not supported' "$tmpdir/hardlink.err" \
  || fail_case "transaction-hardlink" "missing hardlink diagnostic" "$tmpdir/hardlink.err" "$tmpdir"

make_tree_writable "$tmpdir" "$metadata_root" "$nested_metadata_root"
cleanup_dir "$tmpdir"
cleanup_dir "$metadata_root"
cleanup_dir "$nested_metadata_root"
printf 'PASS [filesystem-transaction]\n'
