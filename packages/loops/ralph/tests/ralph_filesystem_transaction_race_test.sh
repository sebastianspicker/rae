#!/usr/bin/env bash
# Deterministic races for atomic quarantine, no-clobber install, and recovery.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds python3 mktemp
tmpdir="$(mktemp -d)"
metadata_root="$(mktemp -d "$HOME/.ralph-fs-race-test.XXXXXX")"
chmod 700 "$metadata_root"

python3 - "$ROOT_DIR/scripts/ralph_fs_txn.py" "$tmpdir" "$metadata_root" <<'PY'
import argparse
import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
from pathlib import Path

helper_path = Path(sys.argv[1])
test_root = Path(sys.argv[2]).resolve()
metadata_root = Path(sys.argv[3]).resolve()
spec = importlib.util.spec_from_file_location("ralph_fs_txn", helper_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def transaction(repo: Path):
    runtime = repo / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    root_bytes = os.fsencode(repo.resolve())
    runtime_bytes = os.fsencode(runtime.resolve())
    pointer = module.metadata_pointer(os.fsencode(metadata_root), root_bytes, runtime_bytes)
    base = {
        "root": str(repo.resolve()),
        "runtime": str(runtime.resolve()),
        "metadata_root": str(metadata_root),
        "pointer": str(pointer),
    }
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        module.mirror_command(argparse.Namespace(**base))
    journal = Path(output.getvalue().strip())
    args = argparse.Namespace(**base, journal=str(journal))
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        module.workspace_command(args)
    return args, journal, Path(output.getvalue().strip()), pointer


def expect_conflict(action, label: str):
    try:
        action()
    except module.TransactionConflict:
        return
    raise AssertionError(f"{label} did not detect an injected conflict")


def cleanup_transaction(journal: Path, pointer: Path):
    state = json.loads(journal.read_text(encoding="utf-8"))
    module.remove_transaction(
        journal,
        pointer,
        os.fsencode(state["mirror"]),
        os.fsencode(state["quarantine_root"]),
        state["evidence"],
        "discarded",
    )


def assert_evidence_retained(journal: Path, pointer: Path):
    state = json.loads(journal.read_text(encoding="utf-8"))
    assert state["state"] == "conflicted"
    assert pointer.exists()
    assert Path(state["quarantine_root"]).is_dir()
    paths = [
        item[field]
        for item in state["evidence"]
        for field in ("quarantine", "staging")
        if item.get(field) is not None
    ]
    assert any(os.path.lexists(value) for value in paths)


def crash_after_promotion_install(args):
    original = module.mark_operation_complete
    crashed = False

    def crash(path, journal, encoded, phase):
        nonlocal crashed
        installed = any(
            item["path"] == encoded and item["state"] == "installed"
            for item in journal["evidence"]
        )
        if not crashed and phase == "promotion" and installed:
            crashed = True
            raise RuntimeError("simulated interruption after no-clobber install")
        original(path, journal, encoded, phase)

    module.mark_operation_complete = crash
    try:
        try:
            module.promote_command(args)
        except RuntimeError as error:
            assert "simulated interruption" in str(error)
        else:
            raise AssertionError("promotion interruption was not injected")
    finally:
        module.mark_operation_complete = original


# A target created after quarantine is never overwritten. Recovery rolls back
# an earlier promoted file while retaining the colliding file's evidence.
repo = test_root / "content-race"
repo.mkdir()
(repo / "a-first.txt").write_text("first baseline\n", encoding="utf-8")
(repo / "z-race.txt").write_text("race baseline\n", encoding="utf-8")
args, journal, workspace, pointer = transaction(repo)
(workspace / "a-first.txt").write_text("first provider\n", encoding="utf-8")
(workspace / "z-race.txt").write_text("race provider\n", encoding="utf-8")
module.prepare_command(args)
injected = False


def content_race(root: bytes, encoded: str, context: str):
    global injected
    if not injected and context == "promotion replacement install" and module.decode_path(encoded) == b"z-race.txt":
        injected = True
        (Path(os.fsdecode(root)) / "z-race.txt").write_text("human race bytes\n", encoding="utf-8")


module.before_live_rename = content_race
expect_conflict(lambda: module.promote_command(args), "promotion content race")
module.before_live_rename = lambda _root, _encoded, _context: None
expect_conflict(lambda: module.discard_command(args), "content-race recovery")
assert (repo / "a-first.txt").read_text(encoding="utf-8") == "first baseline\n"
assert (repo / "z-race.txt").read_text(encoding="utf-8") == "human race bytes\n"
assert_evidence_retained(journal, pointer)
cleanup_transaction(journal, pointer)


# A symlink created after the transaction quarantines the baseline link wins
# the no-clobber collision and remains live.
repo = test_root / "link-race"
repo.mkdir()
os.symlink("baseline-target", repo / "link")
args, journal, workspace, pointer = transaction(repo)
(workspace / "link").unlink()
os.symlink("provider-target", workspace / "link")
module.prepare_command(args)
injected = False


def link_race(root: bytes, encoded: str, context: str):
    global injected
    if not injected and context == "promotion replacement install":
        injected = True
        os.symlink("human-target", Path(os.fsdecode(root)) / "link")


module.before_live_rename = link_race
expect_conflict(lambda: module.promote_command(args), "promotion symlink race")
module.before_live_rename = lambda _root, _encoded, _context: None
expect_conflict(lambda: module.discard_command(args), "symlink-race recovery")
assert os.readlink(repo / "link") == "human-target"
assert_evidence_retained(journal, pointer)
cleanup_transaction(journal, pointer)


# Directory mode promotion quarantines the directory itself. A replacement
# directory created before no-clobber reinstallation is preserved with its
# content and mode.
repo = test_root / "mode-race"
repo.mkdir()
(repo / "mode-dir").mkdir(mode=0o755)
(repo / "mode-dir" / "baseline.txt").write_text("baseline child\n", encoding="utf-8")
os.chmod(repo / "mode-dir", 0o755)
args, journal, workspace, pointer = transaction(repo)
os.chmod(workspace / "mode-dir", 0o700)
module.prepare_command(args)
injected = False


def mode_race(root: bytes, encoded: str, context: str):
    global injected
    if not injected and context == "promotion mode change install":
        injected = True
        live = Path(os.fsdecode(root)) / "mode-dir"
        live.mkdir(mode=0o711)
        (live / "human.txt").write_text("human directory\n", encoding="utf-8")
        os.chmod(live, 0o711)


module.before_live_rename = mode_race
expect_conflict(lambda: module.promote_command(args), "promotion directory-mode race")
module.before_live_rename = lambda _root, _encoded, _context: None
expect_conflict(lambda: module.discard_command(args), "directory-mode recovery")
assert stat.S_IMODE(os.lstat(repo / "mode-dir").st_mode) == 0o711
assert (repo / "mode-dir" / "human.txt").read_text(encoding="utf-8") == "human directory\n"
assert_evidence_retained(journal, pointer)
cleanup_transaction(journal, pointer)


def interrupted_file_transaction(name: str):
    repo = test_root / name
    repo.mkdir()
    (repo / "target.txt").write_text("baseline\n", encoding="utf-8")
    args, journal, workspace, pointer = transaction(repo)
    (workspace / "target.txt").write_text("provider\n", encoding="utf-8")
    module.prepare_command(args)
    return repo, args, journal, pointer


def recover_twice(repo: Path, args, pointer: Path):
    module.before_live_rename = lambda _root, _encoded, _context: None
    module.recover_command(args)
    assert (repo / "target.txt").read_text(encoding="utf-8") == "baseline\n"
    assert not pointer.exists()
    assert module.recover_command(args) == 0


def interrupt_at_hook(name: str, crash_context: str):
    repo, args, _journal, pointer = interrupted_file_transaction(name)
    crashed = False

    def crash(_root: bytes, _encoded: str, context: str):
        nonlocal crashed
        if not crashed and context == crash_context:
            crashed = True
            raise RuntimeError(f"simulated interruption at {context}")

    module.before_live_rename = crash
    try:
        module.promote_command(args)
    except RuntimeError as error:
        assert "simulated interruption" in str(error)
    else:
        raise AssertionError(f"{name} interruption was not injected")
    assert crashed
    recover_twice(repo, args, pointer)


# Recovery is idempotent across the pre-journaled quarantine and install
# boundaries. These hooks leave the journal at planned-quarantine and
# persisted-quarantine states respectively.
interrupt_at_hook(
    "crash-before-quarantine-rename",
    "promotion replacement quarantine",
)
interrupt_at_hook(
    "crash-before-install-rename",
    "promotion replacement install",
)


def interrupt_at_evidence_write(name: str, evidence_state: str):
    repo, args, _journal, pointer = interrupted_file_transaction(name)
    original = module.write_evidence
    crashed = False

    def crash(path, journal):
        nonlocal crashed
        matching = any(
            item["state"] == evidence_state
            for item in journal["evidence"]
        )
        if not crashed and matching:
            crashed = True
            raise RuntimeError(f"simulated interruption before {evidence_state} evidence write")
        original(path, journal)

    module.write_evidence = crash
    try:
        try:
            module.promote_command(args)
        except RuntimeError as error:
            assert "simulated interruption" in str(error)
        else:
            raise AssertionError(f"{name} interruption was not injected")
    finally:
        module.write_evidence = original
    assert crashed
    recover_twice(repo, args, pointer)


interrupt_at_evidence_write(
    "crash-after-quarantine-rename",
    "quarantined",
)
interrupt_at_evidence_write(
    "crash-after-install-rename",
    "installed",
)


# Platforms without a native no-clobber rename fail closed before changing the
# live entry, and the journal remains recoverable.
repo, args, journal, pointer = interrupted_file_transaction("unsupported-no-clobber")
original_rename = module.rename_noreplace


def unsupported_rename(_source: bytes, _target: bytes):
    raise RuntimeError("atomic no-clobber rename is not supported on this platform")


module.rename_noreplace = unsupported_rename
try:
    expect_conflict(lambda: module.promote_command(args), "unsupported no-clobber primitive")
finally:
    module.rename_noreplace = original_rename
assert (repo / "target.txt").read_text(encoding="utf-8") == "baseline\n"
state = json.loads(journal.read_text(encoding="utf-8"))
assert state["state"] == "applying"
assert pointer.exists()
recover_twice(repo, args, pointer)


repo, args, _journal, pointer = interrupted_file_transaction("crash-after-install-evidence")
crash_after_promotion_install(args)
recover_twice(repo, args, pointer)


# A non-empty directory replaced by a symlink is reconstructed from its
# journaled sibling quarantine and child evidence after an interrupted install.
repo = test_root / "crash-directory-kind-change"
repo.mkdir()
(repo / "target").mkdir(mode=0o700)
(repo / "target" / "child.txt").write_text("baseline child\n", encoding="utf-8")
os.chmod(repo / "target", 0o555)
args, _journal, workspace, pointer = transaction(repo)
os.chmod(workspace / "target", 0o700)
(workspace / "target" / "child.txt").unlink()
(workspace / "target").rmdir()
os.symlink("provider-target", workspace / "target")
module.prepare_command(args)
crash_after_promotion_install(args)
module.recover_command(args)
assert (repo / "target").is_dir()
assert (repo / "target" / "child.txt").read_text(encoding="utf-8") == "baseline child\n"
assert stat.S_IMODE(os.lstat(repo / "target").st_mode) == 0o555
assert not list(repo.glob(".ralph-fs-*"))
assert module.recover_command(args) == 0
assert not pointer.exists()


# Edits inside an existing read-only directory use one complete-subtree unit.
# Recovery validates both the root entry and every descendant before restoring
# the immutable baseline subtree.
repo = test_root / "crash-readonly-subtree-edit"
repo.mkdir()
(repo / "target").mkdir(mode=0o700)
(repo / "target" / "child.txt").write_text("baseline child\n", encoding="utf-8")
os.chmod(repo / "target", 0o555)
args, _journal, workspace, pointer = transaction(repo)
os.chmod(workspace / "target", 0o700)
(workspace / "target" / "child.txt").write_text("provider child\n", encoding="utf-8")
os.chmod(workspace / "target", 0o555)
module.prepare_command(args)
crash_after_promotion_install(args)
assert (repo / "target" / "child.txt").read_text(encoding="utf-8") == "provider child\n"
module.recover_command(args)
assert (repo / "target" / "child.txt").read_text(encoding="utf-8") == "baseline child\n"
assert stat.S_IMODE(os.lstat(repo / "target").st_mode) == 0o555
assert not list(repo.glob(".ralph-fs-*"))
assert module.recover_command(args) == 0
assert not pointer.exists()


repo, args, _journal, pointer = interrupted_file_transaction("crash-after-commit-evidence")
original_remove = module.remove_transaction


def crash_cleanup(*_args):
    raise RuntimeError("simulated interruption after committed evidence")


module.remove_transaction = crash_cleanup
try:
    try:
        module.promote_command(args)
    except RuntimeError as error:
        assert "simulated interruption after committed evidence" in str(error)
    else:
        raise AssertionError("post-commit interruption was not injected")
finally:
    module.remove_transaction = original_remove
assert (repo / "target.txt").read_text(encoding="utf-8") == "provider\n"
module.recover_command(args)
assert (repo / "target.txt").read_text(encoding="utf-8") == "provider\n"
assert not pointer.exists()
assert module.recover_command(args) == 0


def terminal_cleanup_checkpoint(checkpoint: str):
    repo, args, journal, pointer = interrupted_file_transaction(
        f"terminal-cleanup-{checkpoint}"
    )
    state = json.loads(journal.read_text(encoding="utf-8"))
    provider_directory = Path(state["mirror"]).parent
    quarantine_root = Path(state["quarantine_root"])
    transaction_directory = journal.parent
    evidence_paths = [
        Path(item[field])
        for item in state["evidence"]
        for field in ("quarantine", "staging")
        if item.get(field) is not None
    ]
    original = module.after_terminal_cleanup_step
    crashed = False

    def crash(step: str):
        nonlocal crashed
        if not crashed and step == checkpoint:
            crashed = True
            raise RuntimeError(f"simulated terminal cleanup crash after {step}")

    module.after_terminal_cleanup_step = crash
    try:
        try:
            module.promote_command(args)
        except RuntimeError as error:
            assert "simulated terminal cleanup crash" in str(error)
        else:
            raise AssertionError(f"terminal cleanup checkpoint {checkpoint} was not reached")
    finally:
        module.after_terminal_cleanup_step = original
    assert crashed
    assert (repo / "target.txt").read_text(encoding="utf-8") == "provider\n"
    module.recover_command(args)
    assert not pointer.exists()
    assert not provider_directory.exists()
    assert not quarantine_root.exists()
    assert not transaction_directory.exists()
    assert not any(path.exists() or path.is_symlink() for path in evidence_paths)
    assert module.recover_command(args) == 0

    next_args, _next_journal, _next_workspace, next_pointer = transaction(repo)
    module.discard_command(next_args)
    assert not next_pointer.exists()
    assert module.recover_command(next_args) == 0


for cleanup_checkpoint in (
    "terminal-marker",
    "mirror",
    "quarantine",
    "transaction",
    "pointer",
):
    terminal_cleanup_checkpoint(cleanup_checkpoint)


def recovery_install_race(
    name: str,
    baseline_factory,
    provider_factory,
    human_factory,
    recovery_context: str,
    assertion,
):
    repo = test_root / name
    repo.mkdir()
    baseline_factory(repo)
    args, journal, workspace, pointer = transaction(repo)
    provider_factory(workspace)
    module.prepare_command(args)
    crash_after_promotion_install(args)
    injected = False

    def inject(root: bytes, _encoded: str, context: str):
        nonlocal injected
        if not injected and context == recovery_context:
            injected = True
            human_factory(Path(os.fsdecode(root)))

    module.before_live_rename = inject
    expect_conflict(lambda: module.recover_command(args), f"{name} recovery race")
    module.before_live_rename = lambda _root, _encoded, _context: None
    assertion(repo)
    assert_evidence_retained(journal, pointer)
    cleanup_transaction(journal, pointer)


recovery_install_race(
    "recovery-content-race",
    lambda repo: (repo / "target.txt").write_text("baseline\n", encoding="utf-8"),
    lambda workspace: (workspace / "target.txt").write_text("provider\n", encoding="utf-8"),
    lambda repo: (repo / "target.txt").write_text("human\n", encoding="utf-8"),
    "recovery replacement install",
    lambda repo: (repo / "target.txt").read_text(encoding="utf-8") == "human\n"
    or (_ for _ in ()).throw(AssertionError("recovery overwrote human file")),
)


def baseline_link(repo: Path):
    os.symlink("baseline", repo / "link")


def provider_link(workspace: Path):
    (workspace / "link").unlink()
    os.symlink("provider", workspace / "link")


recovery_install_race(
    "recovery-link-race",
    baseline_link,
    provider_link,
    lambda repo: os.symlink("human", repo / "link"),
    "recovery replacement install",
    lambda repo: os.readlink(repo / "link") == "human"
    or (_ for _ in ()).throw(AssertionError("recovery overwrote human symlink")),
)


def baseline_directory(repo: Path):
    (repo / "mode-dir").mkdir(mode=0o755)
    (repo / "mode-dir" / "baseline.txt").write_text("baseline\n", encoding="utf-8")
    os.chmod(repo / "mode-dir", 0o755)


def provider_directory(workspace: Path):
    os.chmod(workspace / "mode-dir", 0o700)


def human_directory(repo: Path):
    (repo / "mode-dir").mkdir(mode=0o711)
    (repo / "mode-dir" / "human.txt").write_text("human\n", encoding="utf-8")
    os.chmod(repo / "mode-dir", 0o711)


def assert_human_directory(repo: Path):
    assert stat.S_IMODE(os.lstat(repo / "mode-dir").st_mode) == 0o711
    assert (repo / "mode-dir" / "human.txt").read_text(encoding="utf-8") == "human\n"


recovery_install_race(
    "recovery-directory-race",
    baseline_directory,
    provider_directory,
    human_directory,
    "recovery mode restoration install",
    assert_human_directory,
)
PY

python3 - "$tmpdir" "$metadata_root" <<'PY'
import os
import stat
import sys

for root in sys.argv[1:]:
    for current, directories, _files in os.walk(root, topdown=True, followlinks=False):
        os.chmod(current, stat.S_IMODE(os.lstat(current).st_mode) | 0o700)
        for directory in directories:
            child = os.path.join(current, directory)
            if not os.path.islink(child):
                os.chmod(child, stat.S_IMODE(os.lstat(child).st_mode) | 0o700)
PY
cleanup_dir "$tmpdir"
cleanup_dir "$metadata_root"
printf 'PASS [filesystem-transaction-races]\n'
