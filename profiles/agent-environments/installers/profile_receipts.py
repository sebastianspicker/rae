"""Quarantine receipts, commit, rollback, and recovery for profile mutations."""

import contextlib
import json
import os
import uuid
from dataclasses import dataclass, field

from profile_io import (
    ProfileError,
    close_fd,
    no_clobber_link,
    open_parent,
    parent_is_attached,
    read_named_state,
    test_pause,
    write_atomic,
    write_no_clobber,
)


@dataclass
class MutationReceipt:
    """Stable ownership proof for one pathname mutation."""

    relative: str
    parent_fd: int
    name: str
    old_quarantine: str | None
    before: dict
    installed: dict
    retained_quarantines: list[str] = field(default_factory=list)


class MutationInterrupted(ProfileError):
    """A mutation failed after its receipt became authoritative."""

    def __init__(self, message: str, receipt: MutationReceipt):
        super().__init__(message)
        self.receipt = receipt


class QuarantineMismatch(ProfileError):
    """The atomically captured entry did not match the expected pre-state."""

    def __init__(self, relative: str, quarantine: str, actual: dict):
        super().__init__(f"managed file changed before mutation: {relative}")
        self.relative = relative
        self.quarantine = quarantine
        self.actual = actual


def quarantine_expected(parent_fd: int, name: str, relative: str, expected: dict) -> str | None:
    """Atomically quarantine the expected file and retain evidence if it changed concurrently."""
    if not expected["exists"]:
        return None
    quarantine = f".{name}.{uuid.uuid4().hex}.quarantine"
    try:
        os.rename(name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    except FileNotFoundError as exc:
        raise ProfileError(f"managed file changed before mutation: {relative}") from exc
    actual = read_named_state(parent_fd, quarantine, relative)
    if actual == expected:
        return quarantine
    with contextlib.suppress(FileExistsError):
        no_clobber_link(parent_fd, quarantine, name)
    raise QuarantineMismatch(relative, quarantine, actual)


def guarded_mutation(
    root_fd: int,
    relative: str,
    expected: dict,
    replacement: bytes | None,
    action: str,
) -> MutationReceipt:
    """Apply one replacement with a receipt that supports safe rollback after interruption."""
    parent_fd, name = open_parent(root_fd, relative, create=replacement is not None)
    quarantine = None
    try:
        quarantine = quarantine_expected(parent_fd, name, relative, expected)
        receipt = mutation_receipt(relative, parent_fd, name, quarantine, expected, replacement)
        apply_replacement(root_fd, receipt, replacement, action)
        return receipt
    except MutationInterrupted:
        raise
    except QuarantineMismatch as exc:
        recovery = retain_raw_quarantine(
            root_fd, exc.relative, parent_fd, exc.quarantine, exc.actual
        )
        close_fd(parent_fd)
        raise ProfileError(
            f"{exc}; quarantine retained at {exc.quarantine}; "
            f"recovery material retained at {recovery}"
        ) from exc
    except Exception as exc:
        if quarantine is None:
            close_fd(parent_fd)
            raise
        receipt = mutation_receipt(relative, parent_fd, name, quarantine, expected, None)
        raise MutationInterrupted(str(exc), receipt) from exc


def mutation_receipt(
    relative: str,
    parent_fd: int,
    name: str,
    quarantine: str | None,
    expected: dict,
    replacement: bytes | None,
) -> MutationReceipt:
    installed = {"exists": replacement is not None, "data": replacement or b""}
    return MutationReceipt(relative, parent_fd, name, quarantine, expected, installed)


def apply_replacement(
    root_fd: int,
    receipt: MutationReceipt,
    replacement: bytes | None,
    action: str,
) -> None:
    if replacement is None:
        return
    test_pause(f"{action}-before-replacement", receipt.relative)
    write_no_clobber(receipt.parent_fd, receipt.name, replacement)
    post_replacement_check(root_fd, receipt, action)


def post_replacement_check(root_fd: int, receipt: MutationReceipt, action: str) -> None:
    """Verify the mutation parent remains attached before committing the replacement."""
    hook_error = capture_hook_error(action, receipt.relative)
    if not parent_is_attached(root_fd, receipt.relative, receipt.parent_fd):
        recovery = retain_receipt_recovery(
            root_fd,
            [receipt],
            [receipt.relative],
            "managed parent directory changed after committed mutation",
        )
        raise MutationInterrupted(
            f"managed parent directory changed during mutation: {receipt.relative}; "
            f"recovery material retained at {recovery}",
            receipt,
        )
    if hook_error:
        raise MutationInterrupted(str(hook_error), receipt) from hook_error
    os.fsync(receipt.parent_fd)


def capture_hook_error(action: str, relative: str) -> Exception | None:
    try:
        test_pause(f"{action}-after-replacement", relative)
    except Exception as exc:
        return exc
    return None


def retain_raw_quarantine(
    root_fd: int,
    relative: str,
    parent_fd: int,
    quarantine: str,
    state: dict,
) -> str:
    recovery = f".rae-profile-recovery-{uuid.uuid4().hex}"
    write_atomic(root_fd, f"{recovery}/quarantine/{relative}", state["data"])
    note = {
        "reason": "captured entry did not match the expected pre-state",
        "conflicts": [relative],
        "retained_quarantine": quarantine,
        "retained_parent": parent_identity(parent_fd),
        "manual_recovery": "Compare recovery files with current files before restoring.",
    }
    write_recovery_note(root_fd, recovery, note)
    return recovery


def parent_identity(parent_fd: int) -> dict[str, int]:
    details = os.fstat(parent_fd)
    return {"device": details.st_dev, "inode": details.st_ino}


def retain_receipt_recovery(
    root_fd: int, receipts: list[MutationReceipt], conflicts: list[str], reason: str
) -> str:
    recovery = f".rae-profile-recovery-{uuid.uuid4().hex}"
    for receipt in receipts:
        retain_receipt_files(root_fd, recovery, receipt)
    note = {
        "reason": reason,
        "conflicts": conflicts,
        "manual_recovery": "Compare before/, installed/, and quarantine/ before restoring.",
    }
    write_recovery_note(root_fd, recovery, note)
    return recovery


def write_recovery_note(root_fd: int, recovery: str, note: dict) -> None:
    payload = (json.dumps(note, indent=2) + "\n").encode()
    write_atomic(root_fd, f"{recovery}/RECOVERY.json", payload)


def retain_receipt_files(root_fd: int, recovery: str, receipt: MutationReceipt) -> None:
    if receipt.before["exists"]:
        write_atomic(root_fd, f"{recovery}/before/{receipt.relative}", receipt.before["data"])
    if receipt.installed["exists"]:
        write_atomic(root_fd, f"{recovery}/installed/{receipt.relative}", receipt.installed["data"])
    quarantines = [receipt.old_quarantine, *receipt.retained_quarantines]
    for index, quarantine in enumerate(name for name in quarantines if name):
        retain_quarantine_file(root_fd, recovery, receipt, index, quarantine)


def retain_quarantine_file(
    root_fd: int,
    recovery: str,
    receipt: MutationReceipt,
    index: int,
    quarantine: str,
) -> None:
    state = read_named_state(receipt.parent_fd, quarantine, receipt.relative)
    if state["exists"]:
        write_atomic(
            root_fd,
            f"{recovery}/quarantine/{index}/{receipt.relative}",
            state["data"],
        )


def quarantine_live(receipt: MutationReceipt) -> tuple[str | None, dict]:
    quarantine = f".{receipt.name}.{uuid.uuid4().hex}.rollback"
    try:
        os.rename(
            receipt.name,
            quarantine,
            src_dir_fd=receipt.parent_fd,
            dst_dir_fd=receipt.parent_fd,
        )
    except FileNotFoundError:
        return None, {"exists": False, "data": b""}
    return quarantine, read_named_state(receipt.parent_fd, quarantine, receipt.relative)


def live_matches(receipt: MutationReceipt, expected: dict) -> bool:
    try:
        state = read_named_state(receipt.parent_fd, receipt.name, receipt.relative)
    except ProfileError:
        return False
    return state == expected


def restore_before(receipt: MutationReceipt) -> bool:
    if not receipt.before["exists"]:
        return live_matches(receipt, receipt.before)
    try:
        if receipt.old_quarantine:
            no_clobber_link(receipt.parent_fd, receipt.old_quarantine, receipt.name)
        else:
            write_no_clobber(receipt.parent_fd, receipt.name, receipt.before["data"])
    except FileExistsError:
        return False
    test_pause("rollback-after-hardlink-before-quarantine-unlink", receipt.relative)
    return live_matches(receipt, receipt.before)


def unlink_quarantine_guarded(
    receipt: MutationReceipt, quarantine: str, expected_live: dict
) -> bool:
    if not live_matches(receipt, expected_live):
        return False
    os.unlink(quarantine, dir_fd=receipt.parent_fd)
    return live_matches(receipt, expected_live)


def rollback_receipt(receipt: MutationReceipt) -> bool:
    live_quarantine, actual = quarantine_live(receipt)
    live_quarantine, actual = normalize_rollback_capture(receipt, live_quarantine, actual)
    if actual != receipt.installed:
        preserve_competing_live(receipt, live_quarantine)
        return False
    if not restore_before(receipt):
        retain_name(receipt, live_quarantine)
        return False
    return discard_rollback_quarantines(receipt, live_quarantine)


def normalize_rollback_capture(
    receipt: MutationReceipt, quarantine: str | None, actual: dict
) -> tuple[str | None, dict]:
    if actual == receipt.installed or actual["exists"]:
        return quarantine, actual
    return owned_retained_capture(receipt, quarantine, actual)


def discard_rollback_quarantines(receipt: MutationReceipt, live_quarantine: str | None) -> bool:
    if receipt.old_quarantine and not discard_old_quarantine(receipt):
        retain_name(receipt, live_quarantine)
        return False
    if live_quarantine and not unlink_quarantine_guarded(receipt, live_quarantine, receipt.before):
        retain_name(receipt, live_quarantine)
        return False
    return True


def discard_old_quarantine(receipt: MutationReceipt) -> bool:
    quarantine = receipt.old_quarantine
    if not quarantine:
        return True
    if not unlink_quarantine_guarded(receipt, quarantine, receipt.before):
        return False
    receipt.old_quarantine = None
    return True


def preserve_competing_live(receipt: MutationReceipt, live_quarantine: str | None) -> None:
    if not live_quarantine:
        return
    with contextlib.suppress(FileExistsError):
        no_clobber_link(receipt.parent_fd, live_quarantine, receipt.name)
    receipt.retained_quarantines.append(live_quarantine)


def retain_name(receipt: MutationReceipt, quarantine: str | None) -> None:
    if quarantine:
        receipt.retained_quarantines.append(quarantine)


def owned_retained_capture(
    receipt: MutationReceipt, quarantine: str | None, state: dict
) -> tuple[str | None, dict]:
    for retained in receipt.retained_quarantines:
        retained_state = read_named_state(receipt.parent_fd, retained, receipt.relative)
        if retained_state == receipt.installed:
            receipt.retained_quarantines.remove(retained)
            return retained, retained_state
    return quarantine, state


def rollback(root_fd: int, receipts: list[MutationReceipt]) -> None:
    conflicts = [
        receipt.relative for receipt in reversed(receipts) if not rollback_receipt(receipt)
    ]
    if conflicts:
        recovery = retain_receipt_recovery(
            root_fd, receipts, conflicts, "concurrent modification prevented rollback"
        )
        close_receipts(receipts)
        raise ProfileError(
            f"concurrent edit prevented rollback for {', '.join(conflicts)}; "
            f"recovery material retained at {recovery}; review RECOVERY.json"
        )
    close_receipts(receipts)


def commit_receipts(root_fd: int, receipts: list[MutationReceipt], action: str) -> None:
    captures = [capture_installed(receipt) for receipt in receipts]
    relink_captures(root_fd, receipts, captures, action)
    discard_quarantines(root_fd, receipts, captures)
    close_receipts(receipts)


def capture_installed(receipt: MutationReceipt) -> tuple[MutationReceipt, str | None]:
    quarantine, actual = quarantine_live(receipt)
    if actual == receipt.installed:
        retain_name(receipt, quarantine)
        return receipt, quarantine
    preserve_competing_live(receipt, quarantine)
    raise ProfileError(f"concurrent edit prevented commit for {receipt.relative}")


def relink_captures(
    root_fd: int,
    receipts: list[MutationReceipt],
    captures: list[tuple[MutationReceipt, str | None]],
    action: str,
) -> None:
    for receipt, quarantine in captures:
        test_pause(f"{action}-after-match-before-unlink", receipt.relative)
        if quarantine and not restore_capture_link(receipt, quarantine):
            raise_commit_conflict(root_fd, receipts, receipt)
        if quarantine:
            test_pause(
                f"{action}-commit-after-hardlink-before-quarantine-unlink",
                receipt.relative,
            )
        if not live_matches(receipt, receipt.installed):
            raise_commit_conflict(root_fd, receipts, receipt)


def restore_capture_link(receipt: MutationReceipt, quarantine: str) -> bool:
    try:
        no_clobber_link(receipt.parent_fd, quarantine, receipt.name)
    except FileExistsError:
        return False
    return True


def discard_quarantines(
    root_fd: int,
    receipts: list[MutationReceipt],
    captures: list[tuple[MutationReceipt, str | None]],
) -> None:
    for receipt, quarantine in captures:
        discard_commit_capture(root_fd, receipts, receipt, quarantine)
        discard_commit_original(root_fd, receipts, receipt)


def discard_commit_capture(
    root_fd: int,
    receipts: list[MutationReceipt],
    receipt: MutationReceipt,
    quarantine: str | None,
) -> None:
    if not quarantine:
        return
    if not unlink_quarantine_guarded(receipt, quarantine, receipt.installed):
        raise_commit_conflict(root_fd, receipts, receipt)
    receipt.retained_quarantines.remove(quarantine)


def discard_commit_original(
    root_fd: int, receipts: list[MutationReceipt], receipt: MutationReceipt
) -> None:
    if not receipt.old_quarantine:
        return
    quarantine = receipt.old_quarantine
    if not unlink_quarantine_guarded(receipt, quarantine, receipt.installed):
        raise_commit_conflict(root_fd, receipts, receipt)
    receipt.old_quarantine = None


def raise_commit_conflict(
    root_fd: int, receipts: list[MutationReceipt], receipt: MutationReceipt
) -> None:
    recovery = retain_receipt_recovery(
        root_fd,
        receipts,
        [receipt.relative],
        "post-link alias changed before quarantine evidence was discarded",
    )
    raise ProfileError(
        f"concurrent edit prevented commit for {receipt.relative}; "
        f"recovery material retained at {recovery}"
    )


def close_receipts(receipts: list[MutationReceipt]) -> None:
    for receipt in receipts:
        close_fd(receipt.parent_fd)
