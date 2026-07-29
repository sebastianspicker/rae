"""Descriptor-relative filesystem primitives for profile transactions."""

import contextlib
import os
import stat
import time
import uuid
from pathlib import Path

NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)


class ProfileError(RuntimeError):
    """A validation or transaction failure safe to show to the operator."""


def split_path(relative: str) -> tuple[str, ...]:
    """Reject empty and traversal components before descriptor-relative filesystem access."""
    pieces = tuple(relative.split("/"))
    if not pieces or any(piece in {"", ".", ".."} for piece in pieces):
        raise ProfileError(f"invalid managed relative path: {relative}")
    return pieces


def close_fd(fd: int) -> None:
    with contextlib.suppress(OSError):
        os.close(fd)


def open_target(path: Path) -> int:
    try:
        return os.open(path, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    except FileNotFoundError as exc:
        raise ProfileError(f"target directory does not exist: {path}") from exc
    except OSError as exc:
        raise ProfileError(
            f"target directory must be a non-symlink directory: {path}: {exc}"
        ) from exc


def open_directory(parent_fd: int, component: str, create: bool) -> int:
    """Open or create one managed directory without following a substituted symlink."""
    try:
        return os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
        os.mkdir(component, 0o700, dir_fd=parent_fd)
        return os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
    except OSError as exc:
        raise ProfileError(
            f"managed directory is unsafe or not a directory: {component}: {exc}"
        ) from exc


def open_parent(root_fd: int, relative: str, create: bool = False) -> tuple[int, str]:
    """Walk a validated relative path by file descriptor to resist path races."""
    pieces = split_path(relative)
    current_fd = os.dup(root_fd)
    try:
        for component in pieces[:-1]:
            next_fd = open_directory(current_fd, component, create)
            close_fd(current_fd)
            current_fd = next_fd
        return current_fd, pieces[-1]
    except Exception:
        close_fd(current_fd)
        raise


def file_state(root_fd: int, relative: str) -> dict:
    try:
        parent_fd, name = open_parent(root_fd, relative)
    except FileNotFoundError:
        return {"exists": False, "data": b""}
    try:
        return read_named_state(parent_fd, name, relative)
    finally:
        close_fd(parent_fd)


def read_named_state(parent_fd: int, name: str, relative: str) -> dict:
    """Read a managed regular file without accepting a symlink or special file."""
    try:
        fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        return {"exists": False, "data": b""}
    except OSError as exc:
        raise ProfileError(f"managed file is unsafe: {relative}: {exc}") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ProfileError(f"managed file must be regular: {relative}")
        return {"exists": True, "data": read_all(fd)}
    finally:
        close_fd(fd)


def read_all(fd: int) -> bytes:
    chunks = []
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def write_atomic(root_fd: int, relative: str, payload: bytes) -> None:
    """Replace a managed file atomically after writing and syncing a private temporary file."""
    parent_fd, name = open_parent(root_fd, relative, create=True)
    temporary = f".{name}.{uuid.uuid4().hex}.tmp"
    try:
        write_temporary(parent_fd, temporary, payload)
        os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    except Exception:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=parent_fd)
        raise
    finally:
        close_fd(parent_fd)


def write_temporary(parent_fd: int, name: str, payload: bytes) -> None:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        close_fd(fd)


def no_clobber_link(parent_fd: int, source: str, destination: str) -> None:
    os.link(
        source,
        destination,
        src_dir_fd=parent_fd,
        dst_dir_fd=parent_fd,
        follow_symlinks=False,
    )


def write_no_clobber(parent_fd: int, name: str, payload: bytes) -> None:
    """Install a new file via hard link so a concurrent target is never overwritten."""
    temporary = f".{name}.{uuid.uuid4().hex}.new"
    try:
        write_temporary(parent_fd, temporary, payload)
        no_clobber_link(parent_fd, temporary, name)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=parent_fd)


def parent_is_attached(root_fd: int, relative: str, parent_fd: int) -> bool:
    """Confirm a retained directory descriptor still names the expected live parent."""
    try:
        current_fd, _ = open_parent(root_fd, relative)
    except (FileNotFoundError, ProfileError):
        return False
    try:
        current = os.fstat(current_fd)
        retained = os.fstat(parent_fd)
        return (current.st_dev, current.st_ino) == (retained.st_dev, retained.st_ino)
    finally:
        close_fd(current_fd)


def require_safe_layout(root_fd: int) -> None:
    """Fail closed when profile-managed paths are absent, symlinked, or otherwise unsafe."""
    if not file_state(root_fd, "scripts/verify.sh")["exists"]:
        raise ProfileError("target verifier must be a regular file: scripts/verify.sh")
    for relative in (".codex", ".claude", "docs", ".rae-profile-backups"):
        require_safe_directory(root_fd, relative)


def require_safe_directory(root_fd: int, relative: str) -> None:
    try:
        parent_fd, name = open_parent(root_fd, relative)
    except FileNotFoundError:
        return
    try:
        try:
            fd = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise ProfileError(f"managed directory is unsafe: {relative}: {exc}") from exc
        close_fd(fd)
    finally:
        close_fd(parent_fd)


def test_pause(point: str, relative: str | None = None) -> None:
    hook_dir = os.environ.get("RAE_PROFILE_TEST_PAUSE_DIR")
    if not hook_dir:
        return
    fail_point = os.environ.get("RAE_PROFILE_TEST_FAIL_AFTER_PAUSE")
    pause_point = os.environ.get("RAE_PROFILE_TEST_PAUSE_AT")
    if pause_point and pause_point != point and fail_point == point:
        raise ProfileError(f"test failure requested at {point}")
    if not requested_hook(point, relative):
        return
    directory = Path(hook_dir)
    (directory / f"{point}.ready").write_text("ready\n", encoding="utf-8")
    wait_for_continue(directory, point)
    if os.environ.get("RAE_PROFILE_TEST_FAIL_AFTER_PAUSE") == point:
        raise ProfileError(f"test failure requested at {point}")


def requested_hook(point: str, relative: str | None) -> bool:
    requested = os.environ.get("RAE_PROFILE_TEST_PAUSE_AT") or os.environ.get(
        "RAE_PROFILE_TEST_FAIL_AFTER_PAUSE"
    )
    requested_relative = os.environ.get("RAE_PROFILE_TEST_RELATIVE")
    return (not requested or requested == point) and (
        not requested_relative or requested_relative == relative
    )


def wait_for_continue(directory: Path, point: str) -> None:
    deadline = time.monotonic() + 10
    while not (directory / f"{point}.continue").exists():
        if time.monotonic() >= deadline:
            raise ProfileError(f"test pause timed out at {point}")
        time.sleep(0.01)
