#!/usr/bin/env python3
"""Isolated filesystem transaction for Ralph fixing stories."""

import argparse
import base64
import binascii
import contextlib
import ctypes
import errno
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import uuid
from collections.abc import Iterable
from pathlib import Path
from typing import Any

FORMAT_VERSION = 4
POINTER_DIRECTORY = "pointers"
TRANSACTION_DIRECTORY = "transactions"
PROVIDER_DIRECTORY_PREFIX = "ralph-fs-provider-"
WORKSPACE_NAME = "workspace"


class TransactionDrift(RuntimeError):
    """The live checkout no longer matches the transaction baseline."""


class TransactionConflict(TransactionDrift):
    """A no-clobber filesystem operation found concurrent live state."""


def rename_noreplace(source: bytes, target: bytes) -> None:
    """Atomically rename without replacing an entry that appeared at target."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        function = libc.renamex_np
        function.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        function.restype = ctypes.c_int
        result = function(source, target, 0x00000004)
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        function = libc.renameat2
        function.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        function.restype = ctypes.c_int
        result = function(-100, source, -100, target, 0x00000001)
    else:
        raise RuntimeError("atomic no-clobber rename is not supported on this platform")
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError(error_number, os.strerror(error_number), os.fsdecode(target))
        raise OSError(error_number, os.strerror(error_number), os.fsdecode(source))


def rename_noreplace_same_device(source: bytes, target: bytes) -> None:
    """Fail before mutation when a no-clobber rename cannot stay atomic."""
    source_parent = os.lstat(os.path.dirname(source))
    target_parent = os.lstat(os.path.dirname(target))
    if not stat.S_ISDIR(source_parent.st_mode) or not stat.S_ISDIR(target_parent.st_mode):
        raise TransactionConflict("no-clobber rename parent is not a real directory")
    if source_parent.st_dev != target_parent.st_dev:
        raise TransactionConflict("no-clobber rename crosses filesystem devices")
    rename_noreplace(source, target)


def encode_path(path: bytes) -> str:
    return base64.urlsafe_b64encode(path).decode("ascii")


def decode_bytes(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise RuntimeError(f"{label} must be a base64 string")
    try:
        return base64.b64decode(value.encode("ascii"), altchars=b"-_", validate=True)
    except (UnicodeEncodeError, binascii.Error) as error:
        raise RuntimeError(f"{label} is not valid base64") from error


def decode_path(value: Any) -> bytes:
    path = decode_bytes(value, "manifest path")
    if not path or b"\0" in path or os.path.isabs(path):
        raise RuntimeError("manifest path must be a non-empty relative path")
    parts = path.split(b"/")
    if any(part in (b"", b".", b"..") for part in parts):
        raise RuntimeError("manifest path escapes the transaction root")
    if os.path.normpath(path) != path:
        raise RuntimeError("manifest path is not normalized")
    return path


def fsync_directory(path: str | bytes | Path) -> None:
    descriptor = os.open(os.fsencode(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def json_dump_atomic(path: Path, value: Any) -> None:
    """Persist runner-owned state without exposing a partial JSON document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def path_under(path: bytes, prefix: bytes) -> bool:
    return path == prefix or path.startswith(prefix + b"/")


def canonical_directory(value: str, label: str) -> bytes:
    encoded = os.fsencode(value)
    if not os.path.isabs(encoded) or os.path.normpath(encoded) != encoded:
        raise RuntimeError(f"{label} must be an absolute normalized path")
    if os.path.realpath(encoded) != encoded:
        raise RuntimeError(f"{label} must be canonical and must not use symlinks")
    metadata = os.lstat(encoded)
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"{label} is not a directory")
    return encoded


def metadata_pointer(metadata_root: bytes, root: bytes, runtime: bytes) -> Path:
    digest = hashlib.sha256(root + b"\0" + runtime).hexdigest()
    return Path(os.fsdecode(metadata_root)) / POINTER_DIRECTORY / f"{digest}.json"


def provider_temp_roots() -> tuple[bytes, ...]:
    candidates = [tempfile.gettempdir(), "/tmp", "/var/tmp", "/private/tmp"]
    candidates.extend(os.environ.get(name, "") for name in ("TMPDIR", "TMP", "TEMP"))
    result: list[bytes] = []
    for candidate in candidates:
        if not candidate:
            continue
        canonical = os.path.realpath(os.fsencode(candidate))
        if os.path.isdir(canonical) and canonical not in result:
            result.append(canonical)
    return tuple(result)


def identity_roots(args: argparse.Namespace) -> tuple[bytes, bytes, bytes]:
    root = canonical_directory(args.root, "repository root")
    runtime = canonical_directory(args.runtime, "runtime directory")
    if not path_under(runtime, root) or runtime == root:
        raise RuntimeError("runtime directory must be a child of the repository root")
    metadata_root = canonical_directory(args.metadata_root, "transaction metadata root")
    metadata = os.lstat(metadata_root)
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise RuntimeError("transaction metadata root must be private and owned by the current user")
    for writable in provider_temp_roots():
        if path_under(metadata_root, writable) or path_under(writable, metadata_root):
            raise RuntimeError("transaction metadata root overlaps a provider-writable temp root")
    return root, runtime, metadata_root


def caller_identity(args: argparse.Namespace) -> tuple[bytes, bytes, bytes, Path]:
    root, runtime, metadata_root = identity_roots(args)
    pointer = Path(args.pointer)
    expected = metadata_pointer(metadata_root, root, runtime)
    if not pointer.is_absolute() or Path(os.path.normpath(pointer)) != pointer:
        raise RuntimeError("transaction pointer path must be absolute and normalized")
    if pointer != expected:
        raise RuntimeError("transaction pointer is not bound to the caller identities")
    return root, runtime, metadata_root, pointer


def regular_owned_file(path: Path, label: str) -> os.stat_result:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise RuntimeError(f"{label} must be a regular, non-linked file")
    if metadata.st_uid != os.geteuid():
        raise RuntimeError(f"{label} is not owned by the current user")
    return metadata


def owned_private_directory(path: Path, label: str) -> os.stat_result:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"{label} must be a real directory")
    if metadata.st_uid != os.geteuid():
        raise RuntimeError(f"{label} is not owned by the current user")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise RuntimeError(f"{label} permissions are not private")
    return metadata


def ensure_private_directory(path: Path, label: str) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    owned_private_directory(path, label)


def load_json_file(path: Path, label: str) -> dict[str, Any]:
    regular_owned_file(path, label)
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must contain a JSON object")
    return value


def exclusions(root: bytes, runtime: bytes) -> tuple[bytes, ...]:
    runtime_rel = os.path.relpath(runtime, root)
    if runtime_rel == b"." or runtime_rel.startswith(b".." + os.fsencode(os.sep)):
        raise RuntimeError("runtime directory is not confined to the repository root")
    return b".git", runtime_rel


def relative_child(relative: bytes, name: bytes) -> bytes:
    return os.path.join(relative, name) if relative else name


def validate_entry(rel: bytes, entry: os.DirEntry[bytes]) -> os.stat_result:
    """Reject entries that cannot be copied and promoted without following links."""
    if os.path.basename(rel) == b".git":
        raise RuntimeError(f"nested repository is not supported: {os.fsdecode(rel)}")
    metadata = entry.stat(follow_symlinks=False)
    mode = metadata.st_mode
    if stat.S_ISREG(mode) and metadata.st_nlink != 1:
        raise RuntimeError(f"hard-linked file is not supported: {os.fsdecode(rel)}")
    if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
        raise RuntimeError(f"special file is not supported: {os.fsdecode(rel)}")
    return metadata


def walk_entries(
    root: bytes,
    relative: bytes,
    excluded: tuple[bytes, ...],
) -> Iterable[tuple[bytes, os.stat_result]]:
    absolute = os.path.join(root, relative) if relative else root
    with os.scandir(absolute) as iterator:
        entries = sorted(iterator, key=lambda item: os.fsencode(item.name))
    for entry in entries:
        rel = relative_child(relative, entry.name)
        if any(path_under(rel, item) for item in excluded):
            continue
        metadata = validate_entry(rel, entry)
        yield rel, metadata
        if stat.S_ISDIR(metadata.st_mode):
            yield from walk_entries(root, rel, excluded)


def hash_file(path: bytes) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_entry(root: bytes, rel: bytes, metadata: os.stat_result) -> dict[str, Any]:
    absolute = os.path.join(root, rel)
    entry: dict[str, Any] = {
        "path": encode_path(rel),
        "mode": stat.S_IMODE(metadata.st_mode),
    }
    if stat.S_ISDIR(metadata.st_mode):
        entry["kind"] = "dir"
    elif stat.S_ISLNK(metadata.st_mode):
        entry["kind"] = "symlink"
        entry["target"] = encode_path(os.readlink(absolute))
    else:
        entry["kind"] = "file"
        entry["size"] = metadata.st_size
        entry["sha256"] = hash_file(absolute)
    return entry


def make_manifest(root: bytes, runtime: bytes | None = None) -> list[dict[str, Any]]:
    """Capture a workspace without following symlinks or including runner metadata."""
    if runtime is not None and os.path.lexists(os.path.join(root, b".gitmodules")):
        raise RuntimeError("Git submodules are not supported")
    excluded = exclusions(root, runtime) if runtime is not None else ()
    return [manifest_entry(root, rel, metadata) for rel, metadata in walk_entries(root, b"", excluded)]


def validate_manifest(entries: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(entries, list):
        raise RuntimeError(f"{label} manifest must be a list")
    seen: set[bytes] = set()
    previous: bytes | None = None
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError(f"{label} manifest entry must be an object")
        rel = decode_path(entry.get("path"))
        if rel in seen or (previous is not None and rel <= previous):
            raise RuntimeError(f"{label} manifest paths must be unique and sorted")
        seen.add(rel)
        previous = rel
        kind = entry.get("kind")
        mode = entry.get("mode")
        if kind not in ("dir", "file", "symlink"):
            raise RuntimeError(f"{label} manifest has an unsupported entry kind")
        if not isinstance(mode, int) or isinstance(mode, bool) or not 0 <= mode <= 0o7777:
            raise RuntimeError(f"{label} manifest has an invalid mode")
        if kind == "file":
            if not isinstance(entry.get("size"), int) or entry["size"] < 0:
                raise RuntimeError(f"{label} manifest has an invalid file size")
            digest = entry.get("sha256")
            if not isinstance(digest, str) or len(digest) != 64:
                raise RuntimeError(f"{label} manifest has an invalid file digest")
        elif kind == "symlink":
            decode_bytes(entry.get("target"), "symlink target")
    return entries


def manifest_map(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {entry["path"]: entry for entry in entries}


def manifest_subtree(
    entries: list[dict[str, Any]],
    encoded: str,
) -> list[dict[str, Any]]:
    rel = decode_path(encoded)
    return [
        entry
        for entry in entries
        if decode_path(entry["path"]) == rel
        or decode_path(entry["path"]).startswith(rel + b"/")
    ]


def changed_paths(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[str]:
    left = manifest_map(before)
    right = manifest_map(after)
    return sorted(key for key in left.keys() | right.keys() if left.get(key) != right.get(key))


def safe_absolute(root: bytes, rel: bytes) -> bytes:
    """Resolve a manifest child lexically while rejecting symlinked parent traversal."""
    decode_path(encode_path(rel))
    current = root
    for part in rel.split(b"/")[:-1]:
        current = os.path.join(current, part)
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            break
        if not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"manifest parent is not a real directory: {os.fsdecode(rel)}")
    return os.path.join(root, rel)


def entry_at(root: bytes, encoded: str) -> dict[str, Any] | None:
    rel = decode_path(encoded)
    absolute = safe_absolute(root, rel)
    try:
        metadata = os.lstat(absolute)
    except FileNotFoundError:
        return None
    if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
        raise RuntimeError(f"hard-linked file is not supported: {os.fsdecode(rel)}")
    if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)):
        raise RuntimeError(f"special file is not supported: {os.fsdecode(rel)}")
    return manifest_entry(root, rel, metadata)


def entry_at_absolute(absolute: bytes, encoded: str) -> dict[str, Any] | None:
    rel = decode_path(encoded)
    try:
        metadata = os.lstat(absolute)
    except FileNotFoundError:
        return None
    if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
        raise RuntimeError(f"hard-linked file is not supported: {os.fsdecode(rel)}")
    entry: dict[str, Any] = {
        "path": encoded,
        "mode": stat.S_IMODE(metadata.st_mode),
    }
    if stat.S_ISDIR(metadata.st_mode):
        entry["kind"] = "dir"
    elif stat.S_ISLNK(metadata.st_mode):
        entry["kind"] = "symlink"
        entry["target"] = encode_path(os.readlink(absolute))
    elif stat.S_ISREG(metadata.st_mode):
        entry["kind"] = "file"
        entry["size"] = metadata.st_size
        entry["sha256"] = hash_file(absolute)
    else:
        raise RuntimeError(f"special file is not supported: {os.fsdecode(rel)}")
    return entry


def subtree_manifest_absolute(absolute: bytes, encoded: str) -> list[dict[str, Any]]:
    root_entry = entry_at_absolute(absolute, encoded)
    if root_entry is None:
        return []
    result = [root_entry]
    if root_entry["kind"] != "dir":
        return result
    base = decode_path(encoded)
    for child, metadata in walk_entries(absolute, b"", ()):
        entry = manifest_entry(absolute, child, metadata)
        entry["path"] = encode_path(os.path.join(base, child))
        result.append(entry)
    return result


def copy_entry(root: bytes, mirror: bytes, entry: dict[str, Any]) -> None:
    rel = decode_path(entry["path"])
    source = safe_absolute(root, rel)
    target = safe_absolute(mirror, rel)
    if entry["kind"] == "dir":
        os.makedirs(target, mode=0o700, exist_ok=True)
    elif entry["kind"] == "symlink":
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        os.symlink(decode_bytes(entry["target"], "symlink target"), target)
    else:
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        shutil.copyfile(source, target, follow_symlinks=False)
        os.chmod(target, entry["mode"], follow_symlinks=False)


def copy_manifest(source: bytes, target: bytes, manifest: list[dict[str, Any]]) -> None:
    directories: list[dict[str, Any]] = []
    for entry in manifest:
        copy_entry(source, target, entry)
        if entry["kind"] == "dir":
            directories.append(entry)
    for entry in reversed(directories):
        os.chmod(os.path.join(target, decode_path(entry["path"])), entry["mode"], follow_symlinks=False)


def identity(metadata: os.stat_result) -> dict[str, int]:
    return {"device": metadata.st_dev, "inode": metadata.st_ino}


def validate_identity(path: bytes, expected: Any, label: str) -> None:
    if not isinstance(expected, dict):
        raise RuntimeError(f"{label} identity is missing")
    metadata = os.lstat(path)
    if identity(metadata) != expected:
        raise RuntimeError(f"{label} identity changed")


def pointer_data(pointer: Path) -> dict[str, Any]:
    data = load_json_file(pointer, "transaction pointer")
    if data.get("format") != FORMAT_VERSION:
        raise RuntimeError("unsupported transaction pointer format")
    return data


def pointer_journal_path(
    data: dict[str, Any],
    root: bytes,
    runtime: bytes,
    metadata_root: bytes,
) -> Path:
    if data.get("root") != os.fsdecode(root) or data.get("runtime") != os.fsdecode(runtime):
        raise RuntimeError("transaction pointer is bound to a different repository")
    if data.get("metadata_root") != os.fsdecode(metadata_root):
        raise RuntimeError("transaction pointer is bound to a different metadata root")
    if not isinstance(data.get("id"), str) or not data["id"]:
        raise RuntimeError("transaction pointer id is invalid")
    if data.get("terminal") not in (None, "committed", "recovered", "discarded"):
        raise RuntimeError("transaction pointer terminal state is invalid")
    journal_value = data.get("journal")
    if not isinstance(journal_value, str):
        raise RuntimeError("transaction pointer journal path is invalid")
    journal_path = Path(journal_value)
    if not journal_path.is_absolute() or os.path.realpath(journal_path) != os.fspath(journal_path):
        raise RuntimeError("transaction journal path must be canonical")
    expected_parent = Path(os.fsdecode(metadata_root)) / TRANSACTION_DIRECTORY
    owned_private_directory(expected_parent, "transaction directory parent")
    if journal_path.parent.parent != expected_parent:
        raise RuntimeError("transaction journal is outside the metadata root")
    if not journal_path.parent.name.startswith("txn-"):
        raise RuntimeError("transaction directory has an unexpected location")
    if journal_path != journal_path.parent / "journal.json":
        raise RuntimeError("transaction journal has an unexpected location")
    return journal_path


def load_bound_journal(
    args: argparse.Namespace,
    require_pointer: bool = True,
    allow_terminal_cleanup: bool = False,
) -> tuple[Path, dict[str, Any], bytes, bytes, bytes, Path]:
    root, runtime, metadata_root, pointer = caller_identity(args)
    data = pointer_data(pointer) if require_pointer else None
    if data is not None:
        bound_journal_path = pointer_journal_path(data, root, runtime, metadata_root)
    else:
        bound_journal_path = None
    journal_value = getattr(args, "journal", None) or bound_journal_path
    if journal_value is None:
        raise RuntimeError("transaction journal path is required")
    journal_path = Path(journal_value)
    if not journal_path.is_absolute() or os.path.realpath(journal_path) != os.fspath(journal_path):
        raise RuntimeError("transaction journal path must be canonical")
    transaction_dir = journal_path.parent
    owned_private_directory(transaction_dir, "transaction directory")
    expected_transaction_parent = Path(os.fsdecode(metadata_root)) / TRANSACTION_DIRECTORY
    if transaction_dir.parent != expected_transaction_parent:
        raise RuntimeError("transaction journal is outside the metadata root")
    owned_private_directory(expected_transaction_parent, "transaction directory parent")
    if journal_path != transaction_dir / "journal.json":
        raise RuntimeError("transaction journal has an unexpected location")
    journal = load_json_file(journal_path, "transaction journal")
    if journal.get("format") != FORMAT_VERSION:
        raise RuntimeError("unsupported transaction journal format")
    state = journal.get("state")
    valid_states = (
        "mirrored",
        "prepared",
        "applying",
        "recovering",
        "conflicted",
        "committed",
        "recovered",
    )
    if state not in valid_states:
        raise RuntimeError("transaction journal has an invalid state")
    if data is not None:
        if data.get("journal") != str(journal_path) or data.get("id") != journal.get("id"):
            raise RuntimeError("transaction pointer does not match its journal")
    terminal_marker = data.get("terminal") if data is not None else None
    terminal_cleanup = allow_terminal_cleanup and (
        (terminal_marker == "committed" and state == "committed")
        or (terminal_marker == "recovered" and state == "recovered")
        or (terminal_marker == "discarded" and state in ("mirrored", "prepared"))
    )
    if journal.get("root") != os.fsdecode(root) or journal.get("runtime") != os.fsdecode(runtime):
        raise RuntimeError("transaction journal is bound to a different repository")
    if journal.get("metadata_root") != os.fsdecode(metadata_root):
        raise RuntimeError("transaction journal is bound to a different metadata root")
    quarantine_root = os.fsencode(journal.get("quarantine_root", ""))
    expected_quarantine_root = os.path.join(
        runtime,
        b".fixing-quarantine",
        os.fsencode(journal.get("id", "")),
    )
    if quarantine_root != expected_quarantine_root:
        raise RuntimeError("transaction quarantine root has an unexpected location")
    mirror = os.fsencode(journal.get("mirror", ""))
    mirror_path = Path(os.fsdecode(mirror))
    provider_directory = mirror_path.parent
    if os.path.realpath(mirror) != mirror or mirror_path.name != WORKSPACE_NAME:
        raise RuntimeError("transaction mirror has an unexpected location")
    if not provider_directory.name.startswith(PROVIDER_DIRECTORY_PREFIX):
        raise RuntimeError("transaction provider directory has an unexpected location")
    if provider_directory.parent != Path(os.fsdecode(os.path.realpath(os.fsencode(tempfile.gettempdir())))):
        raise RuntimeError("transaction mirror is outside the provider temp root")
    if path_under(mirror, metadata_root):
        raise RuntimeError("transaction mirror overlaps runner-owned metadata")
    mirror_metadata = None
    provider_metadata = None
    if os.path.lexists(provider_directory):
        provider_metadata = owned_private_directory(
            provider_directory,
            "transaction provider directory",
        )
    elif not terminal_cleanup:
        raise RuntimeError("transaction provider directory is missing")
    if os.path.lexists(mirror):
        mirror_metadata = owned_private_directory(
            Path(os.fsdecode(mirror)),
            "transaction mirror",
        )
    elif not terminal_cleanup:
        raise RuntimeError("transaction mirror is missing")
    baseline_store = os.fsencode(journal.get("baseline_store", ""))
    expected_baseline_store = os.fsencode(transaction_dir / "baseline")
    if baseline_store != expected_baseline_store or os.path.realpath(baseline_store) != baseline_store:
        raise RuntimeError("transaction baseline store has an unexpected location")
    baseline_store_metadata = None
    if os.path.lexists(baseline_store):
        baseline_store_metadata = owned_private_directory(
            Path(os.fsdecode(baseline_store)), "transaction baseline store"
        )
    elif not terminal_cleanup:
        raise RuntimeError("transaction baseline store is missing")
    validate_identity(root, journal.get("root_identity"), "repository root")
    validate_identity(runtime, journal.get("runtime_identity"), "runtime directory")
    validate_identity(
        metadata_root,
        journal.get("metadata_root_identity"),
        "transaction metadata root",
    )
    if mirror_metadata is not None and identity(mirror_metadata) != journal.get("mirror_identity"):
        raise RuntimeError("transaction mirror identity changed")
    if provider_metadata is not None and identity(provider_metadata) != journal.get("provider_directory_identity"):
        raise RuntimeError("transaction provider directory identity changed")
    if baseline_store_metadata is not None and identity(baseline_store_metadata) != journal.get("baseline_store_identity"):
        raise RuntimeError("transaction baseline store identity changed")
    validate_manifest(journal.get("baseline"), "baseline")
    if (
        baseline_store_metadata is not None
        and not terminal_cleanup
        and make_manifest(baseline_store) != journal["baseline"]
    ):
        raise RuntimeError("transaction baseline store does not match its manifest")
    if journal.get("prepared") is not None:
        validate_manifest(journal["prepared"], "prepared")
    changed = journal.get("changed", [])
    promoted = journal.get("promoted", [])
    active = journal.get("active")
    active_started = journal.get("active_started", False)
    evidence = journal.get("evidence", [])
    if not isinstance(changed, list) or not isinstance(promoted, list):
        raise RuntimeError("transaction path journal is invalid")
    if not isinstance(active_started, bool) or (active is None and active_started):
        raise RuntimeError("transaction active-path state is invalid")
    if not isinstance(evidence, list):
        raise RuntimeError("transaction recovery evidence is invalid")
    for item in evidence:
        if not isinstance(item, dict):
            raise RuntimeError("transaction recovery evidence entry is invalid")
        evidence_rel = decode_path(item.get("path"))
        if not isinstance(item.get("id"), str) or not item["id"]:
            raise RuntimeError("transaction recovery evidence id is invalid")
        if not isinstance(item.get("context"), str) or not item["context"]:
            raise RuntimeError("transaction recovery evidence context is invalid")
        if item.get("phase") not in ("promotion", "recovery"):
            raise RuntimeError("transaction recovery evidence phase is invalid")
        if not isinstance(item.get("subtree", False), bool):
            raise RuntimeError("transaction recovery evidence subtree marker is invalid")
        if item.get("state") not in (
            "planned",
            "quarantined",
            "staged",
            "installed",
            "restored-conflict",
            "conflict",
        ):
            raise RuntimeError("transaction recovery evidence state is invalid")
        for field in ("quarantine", "staging"):
            value = item.get(field)
            if value is None:
                continue
            if not isinstance(value, str):
                raise RuntimeError("transaction recovery evidence path is invalid")
            encoded_value = os.fsencode(value)
            if not os.path.isabs(encoded_value) or os.path.normpath(encoded_value) != encoded_value:
                raise RuntimeError("transaction recovery evidence path is invalid")
            central_location = os.path.dirname(encoded_value) == quarantine_root
            live_parent = os.path.dirname(os.path.join(root, evidence_rel))
            sibling_name = os.path.basename(encoded_value)
            suffixes = [os.fsencode(f"-{field}")]
            if field == "staging":
                suffixes.append(b"-quarantine")
            sibling_location = (
                os.path.dirname(encoded_value) == live_parent
                and sibling_name.startswith(os.fsencode(f".ralph-fs-{journal['id']}-"))
                and any(sibling_name.endswith(suffix) for suffix in suffixes)
            )
            if not central_location and not sibling_location:
                raise RuntimeError("transaction recovery evidence escapes quarantine root")
    for encoded in changed + promoted + ([active] if active is not None else []):
        decode_path(encoded)
    if journal.get("prepared") is not None:
        expected_changed = changed_paths(journal["baseline"], journal["prepared"])
        if changed != expected_changed:
            raise RuntimeError("transaction changed-path journal does not match its manifests")
        baseline_map = manifest_map(journal["baseline"])
        prepared_map = manifest_map(journal["prepared"])

        def valid_unit(encoded: str) -> bool:
            before = baseline_map.get(encoded)
            after = prepared_map.get(encoded)
            rel = decode_path(encoded)
            return encoded in changed or (
                before is not None
                and after is not None
                and before["kind"] == "dir"
                and after["kind"] == "dir"
                and any(
                    decode_path(item) != rel
                    and path_under(decode_path(item), rel)
                    for item in changed
                )
            )

        if any(not valid_unit(encoded) for encoded in promoted):
            raise RuntimeError("transaction promoted-path journal escapes the prepared change set")
        if active is not None and not valid_unit(active):
            raise RuntimeError("transaction active path escapes the prepared change set")
        if any(not valid_unit(item["path"]) for item in evidence):
            raise RuntimeError("transaction recovery evidence escapes the prepared change set")
    return journal_path, journal, root, runtime, mirror, pointer


def remove_tree(path: str | bytes | Path) -> None:
    encoded = os.fsencode(path)
    parent = os.path.dirname(encoded)
    try:
        metadata = os.lstat(encoded)
    except FileNotFoundError:
        with contextlib.suppress(FileNotFoundError):
            fsync_directory(parent)
        return
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(encoded)
        fsync_directory(parent)
        return

    def make_writable(directory: bytes) -> None:
        os.chmod(directory, 0o700, follow_symlinks=False)
        with os.scandir(directory) as entries:
            children = list(entries)
        for child in children:
            child_metadata = child.stat(follow_symlinks=False)
            if stat.S_ISDIR(child_metadata.st_mode):
                make_writable(os.path.join(directory, child.name))

    make_writable(encoded)
    shutil.rmtree(encoded)
    fsync_directory(parent)


def after_terminal_cleanup_step(step: str) -> None:
    """Test seam invoked after each durable terminal-cleanup boundary."""


def mark_terminal_pointer(pointer: Path, terminal_state: str) -> None:
    if terminal_state not in ("committed", "recovered", "discarded"):
        raise RuntimeError("transaction cleanup state is not terminal")
    data = pointer_data(pointer)
    existing = data.get("terminal")
    if existing not in (None, terminal_state):
        raise RuntimeError("transaction pointer terminal state changed")
    data["terminal"] = terminal_state
    json_dump_atomic(pointer, data)


def unlink_pointer_durable(pointer: Path) -> None:
    pointer.unlink(missing_ok=True)
    fsync_directory(pointer.parent)


def remove_transaction(
    journal_path: Path,
    pointer: Path,
    mirror: bytes,
    quarantine_root: bytes,
    evidence: list[dict[str, Any]] | None,
    terminal_state: str,
) -> None:
    mark_terminal_pointer(pointer, terminal_state)
    after_terminal_cleanup_step("terminal-marker")
    for item in evidence or []:
        for field in ("quarantine", "staging"):
            value = item.get(field)
            if value is None:
                continue
            remove_tree(value)
    after_terminal_cleanup_step("evidence")
    remove_tree(Path(os.fsdecode(mirror)).parent)
    after_terminal_cleanup_step("mirror")
    remove_tree(quarantine_root)
    after_terminal_cleanup_step("quarantine")
    quarantine_parent = os.path.dirname(quarantine_root)
    with contextlib.suppress(OSError):
        os.rmdir(quarantine_parent)
    with contextlib.suppress(FileNotFoundError):
        fsync_directory(os.path.dirname(quarantine_parent))
    remove_tree(journal_path.parent)
    after_terminal_cleanup_step("transaction")
    unlink_pointer_durable(pointer)
    after_terminal_cleanup_step("pointer")


def snapshot_command(args: argparse.Namespace) -> int:
    root = canonical_directory(args.root, "repository root")
    runtime = canonical_directory(args.runtime, "runtime directory")
    manifest = make_manifest(root, runtime)
    json_dump_atomic(Path(args.output), {"format": FORMAT_VERSION, "entries": manifest})
    return 0


def pointer_path_command(args: argparse.Namespace) -> int:
    root, runtime, metadata_root = identity_roots(args)
    print(metadata_pointer(metadata_root, root, runtime))
    return 0


def mirror_command(args: argparse.Namespace) -> int:
    root, runtime, metadata_root, pointer = caller_identity(args)
    if os.path.lexists(pointer):
        raise RuntimeError("transaction pointer already exists")
    metadata_path = Path(os.fsdecode(metadata_root))
    transaction_parent = metadata_path / TRANSACTION_DIRECTORY
    pointer_parent = metadata_path / POINTER_DIRECTORY
    ensure_private_directory(transaction_parent, "transaction directory parent")
    ensure_private_directory(pointer_parent, "transaction pointer parent")
    transaction_dir = Path(
        os.path.realpath(tempfile.mkdtemp(prefix="txn-", dir=transaction_parent))
    )
    provider_directory = Path(
        os.path.realpath(tempfile.mkdtemp(prefix=PROVIDER_DIRECTORY_PREFIX))
    )
    mirror_path = provider_directory / WORKSPACE_NAME
    mirror_path.mkdir(mode=0o700)
    os.chmod(transaction_dir, 0o700)
    os.chmod(provider_directory, 0o700)
    try:
        baseline_path = transaction_dir / "baseline"
        baseline_path.mkdir(mode=0o700)
        mirror = os.fsencode(mirror_path)
        baseline_store = os.fsencode(baseline_path)
        manifest = make_manifest(root, runtime)
        copy_manifest(root, baseline_store, manifest)
        copy_manifest(root, mirror, manifest)
        transaction_id = str(uuid.uuid4())
        quarantine_root = os.path.join(runtime, b".fixing-quarantine", os.fsencode(transaction_id))
        journal = {
            "format": FORMAT_VERSION,
            "id": transaction_id,
            "state": "mirrored",
            "root": os.fsdecode(root),
            "runtime": os.fsdecode(runtime),
            "metadata_root": os.fsdecode(metadata_root),
            "mirror": os.fsdecode(mirror),
            "baseline_store": os.fsdecode(baseline_store),
            "quarantine_root": os.fsdecode(quarantine_root),
            "root_identity": identity(os.lstat(root)),
            "runtime_identity": identity(os.lstat(runtime)),
            "metadata_root_identity": identity(os.lstat(metadata_root)),
            "mirror_identity": identity(os.lstat(mirror)),
            "provider_directory_identity": identity(os.lstat(provider_directory)),
            "baseline_store_identity": identity(os.lstat(baseline_store)),
            "baseline": manifest,
            "prepared": None,
            "changed": [],
            "promoted": [],
            "active": None,
            "active_started": False,
            "evidence": [],
        }
        journal_path = transaction_dir / "journal.json"
        json_dump_atomic(journal_path, journal)
        json_dump_atomic(pointer, {
            "format": FORMAT_VERSION,
            "id": journal["id"],
            "root": journal["root"],
            "runtime": journal["runtime"],
            "metadata_root": journal["metadata_root"],
            "journal": str(journal_path),
        })
    except BaseException:
        with contextlib.suppress(OSError):
            remove_tree(transaction_dir)
        with contextlib.suppress(OSError):
            remove_tree(provider_directory)
        with contextlib.suppress(FileNotFoundError):
            pointer.unlink()
        raise
    print(journal_path)
    return 0


def workspace_command(args: argparse.Namespace) -> int:
    _, _, _, _, mirror, _ = load_bound_journal(args)
    print(os.fsdecode(mirror))
    return 0


def required_manifest_entry(
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> dict[str, Any]:
    entry = after or before
    if entry is None:
        raise RuntimeError("changed path is absent from both manifests")
    return entry


def render_scope_diff_path(
    encoded: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    changed_bytes: list[bytes],
) -> str | None:
    entry = required_manifest_entry(before, after)
    if entry["kind"] != "dir" or (before is not None and after is not None):
        return encoded
    rel = decode_path(encoded)
    if any(other.startswith(rel + b"/") for other in changed_bytes):
        return None
    return encode_path(rel + b"/")


def diff_command(args: argparse.Namespace) -> int:
    _, journal, _, _, mirror, _ = load_bound_journal(args)
    current = make_manifest(mirror)
    left = manifest_map(journal["baseline"])
    right = manifest_map(current)
    changed = changed_paths(journal["baseline"], current)
    changed_bytes = [decode_path(value) for value in changed]
    for encoded in changed:
        rendered = render_scope_diff_path(encoded, left.get(encoded), right.get(encoded), changed_bytes)
        if rendered is not None:
            print(rendered)
    return 0


def prepare_command(args: argparse.Namespace) -> int:
    path, journal, _, _, mirror, _ = load_bound_journal(args)
    if journal.get("state") != "mirrored":
        raise RuntimeError("transaction is not ready for preparation")
    prepared = make_manifest(mirror)
    journal["prepared"] = prepared
    journal["changed"] = changed_paths(journal["baseline"], prepared)
    journal["state"] = "prepared"
    json_dump_atomic(path, journal)
    return 0


def subtree_manifest(root: bytes, encoded: str) -> list[dict[str, Any]]:
    rel = decode_path(encoded)
    current = entry_at(root, encoded)
    if current is None:
        return []
    result = [current]
    if current["kind"] == "dir":
        result.extend(manifest_entry(root, child, metadata) for child, metadata in walk_entries(root, rel, ()))
    return result


def verify_live_baseline(journal: dict[str, Any], root: bytes) -> list[str]:
    baseline = manifest_map(journal["baseline"])
    prepared = manifest_map(journal["prepared"])
    drift: list[str] = []
    checked_subtrees: set[str] = set()
    structural_parents: set[str] = set()
    for encoded in sorted(journal["changed"], key=lambda item: (depth(item), item)):
        before = baseline.get(encoded)
        after = prepared.get(encoded)
        rel = decode_path(encoded)
        if any(
            rel != decode_path(parent) and path_under(rel, decode_path(parent))
            for parent in structural_parents
        ):
            continue
        if before is not None and before["kind"] == "dir" and (after is None or after["kind"] != "dir"):
            checked_subtrees.add(encoded)
            expected = manifest_subtree(journal["baseline"], encoded)
            if subtree_manifest(root, encoded) != expected:
                drift.append(encoded)
            structural_parents.add(encoded)
        elif not any(path_under(rel, decode_path(parent)) for parent in checked_subtrees):
            if entry_at(root, encoded) != before:
                drift.append(encoded)
            if (
                (before is not None and before["kind"] != "dir" and after is not None and after["kind"] == "dir")
                or (before is None and after is not None and after["kind"] == "dir")
            ):
                structural_parents.add(encoded)
    return sorted(set(drift))


def verify_command(args: argparse.Namespace) -> int:
    _, journal, root, _, mirror, _ = load_bound_journal(args)
    if journal.get("state") != "prepared" or journal.get("prepared") is None:
        raise RuntimeError("transaction has not been prepared")
    if make_manifest(mirror) != journal["prepared"]:
        raise RuntimeError("transaction workspace changed after preparation")
    drift = verify_live_baseline(journal, root)
    if drift:
        for encoded in drift:
            print(encoded)
        return 3
    return 0


def depth(encoded: str) -> int:
    return decode_path(encoded).count(b"/")


def before_live_rename(root: bytes, encoded: str, context: str) -> None:
    """Test seam invoked immediately before an atomic live-path mutation."""


def evidence_path(
    journal: dict[str, Any],
    suffix: str,
    root: bytes | None = None,
    encoded: str | None = None,
) -> bytes:
    name = os.fsencode(f"{uuid.uuid4().hex}-{suffix}")
    if root is not None and encoded is not None:
        live_parent = os.path.dirname(safe_absolute(root, decode_path(encoded)))
        name = os.fsencode(f".ralph-fs-{journal['id']}-{os.fsdecode(name)}")
        return os.path.join(live_parent, name)
    return os.path.join(
        os.fsencode(journal["quarantine_root"]),
        name,
    )


def ensure_quarantine_root(journal: dict[str, Any], root: bytes) -> bytes:
    quarantine_root = os.fsencode(journal["quarantine_root"])
    parent = os.path.dirname(quarantine_root)
    for directory, label in (
        (parent, "transaction quarantine parent"),
        (quarantine_root, "transaction quarantine root"),
    ):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
        metadata = owned_private_directory(Path(os.fsdecode(directory)), label)
        if os.path.realpath(directory) != directory:
            raise RuntimeError(f"{label} must be canonical")
        if metadata.st_dev != os.lstat(root).st_dev:
            raise RuntimeError("transaction quarantine must share the repository filesystem")
    return quarantine_root


def write_evidence(path: Path, journal: dict[str, Any]) -> None:
    json_dump_atomic(path, journal)


def new_evidence(
    path: Path,
    journal: dict[str, Any],
    encoded: str,
    context: str,
    phase: str,
    quarantine: bytes | None = None,
    staging: bytes | None = None,
    subtree: bool = False,
) -> dict[str, Any]:
    item = {
        "id": uuid.uuid4().hex,
        "path": encoded,
        "context": context,
        "phase": phase,
        "state": "planned",
        "subtree": subtree,
        "quarantine": os.fsdecode(quarantine) if quarantine is not None else None,
        "staging": os.fsdecode(staging) if staging is not None else None,
    }
    journal["evidence"].append(item)
    journal["active"] = encoded
    journal["active_started"] = True
    write_evidence(path, journal)
    return item


def mark_operation_complete(
    path: Path,
    journal: dict[str, Any],
    encoded: str,
    phase: str,
) -> None:
    if phase == "promotion" and encoded not in journal["promoted"]:
        journal["promoted"].append(encoded)
    journal["active"] = None
    journal["active_started"] = False
    write_evidence(path, journal)


def conflict_message(encoded: str, context: str) -> str:
    return f"live checkout changed during {context}: {os.fsdecode(decode_path(encoded))}"


def quarantine_live_entry(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    encoded: str,
    expected: dict[str, Any],
    context: str,
    phase: str,
    expected_subtree: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ensure_quarantine_root(journal, root)
    target = safe_absolute(root, decode_path(encoded))
    quarantine = evidence_path(
        journal,
        "quarantine",
        root if expected["kind"] == "dir" else None,
        encoded if expected["kind"] == "dir" else None,
    )
    item = new_evidence(
        path,
        journal,
        encoded,
        context,
        phase,
        quarantine=quarantine,
        subtree=expected_subtree is not None,
    )
    before_live_rename(root, encoded, f"{context} quarantine")
    try:
        rename_noreplace_same_device(target, quarantine)
    except (OSError, RuntimeError) as error:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(conflict_message(encoded, context)) from error
    item["state"] = "quarantined"
    write_evidence(path, journal)
    entry_matches = entry_at_absolute(quarantine, encoded) == expected
    subtree_matches = (
        expected_subtree is None
        or subtree_manifest_absolute(quarantine, encoded) == expected_subtree
    )
    if entry_matches and subtree_matches:
        return item

    try:
        rename_noreplace_same_device(quarantine, target)
    except (OSError, RuntimeError):
        item["state"] = "conflict"
    else:
        item["state"] = "restored-conflict"
    write_evidence(path, journal)
    raise TransactionConflict(conflict_message(encoded, context))


def stage_manifest_entry(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    source_root: bytes,
    entry: dict[str, Any],
    context: str,
    phase: str,
) -> dict[str, Any]:
    ensure_quarantine_root(journal, root)
    encoded = entry["path"]
    staging = evidence_path(
        journal,
        "staging",
        root if entry["kind"] == "dir" else None,
        encoded if entry["kind"] == "dir" else None,
    )
    item = new_evidence(
        path,
        journal,
        encoded,
        context,
        phase,
        staging=staging,
    )
    if entry["kind"] == "dir":
        os.mkdir(staging, 0o700)
        os.chmod(staging, entry["mode"], follow_symlinks=False)
    elif entry["kind"] == "symlink":
        os.symlink(decode_bytes(entry["target"], "symlink target"), staging)
    else:
        source = safe_absolute(source_root, decode_path(encoded))
        shutil.copyfile(source, staging, follow_symlinks=False)
        os.chmod(staging, entry["mode"], follow_symlinks=False)
    if entry_at_absolute(staging, encoded) != entry:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(f"staged transaction entry changed during {context}")
    item["state"] = "staged"
    write_evidence(path, journal)
    return item


def stage_directory_subtree(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    source_root: bytes,
    source_manifest: list[dict[str, Any]],
    entry: dict[str, Any],
    context: str,
    phase: str,
) -> dict[str, Any]:
    ensure_quarantine_root(journal, root)
    encoded = entry["path"]
    staging = evidence_path(journal, "staging", root, encoded)
    item = new_evidence(
        path,
        journal,
        encoded,
        context,
        phase,
        staging=staging,
        subtree=True,
    )
    os.mkdir(staging, 0o700)
    source = safe_absolute(source_root, decode_path(encoded))
    contents = make_manifest(source)
    copy_manifest(source, staging, contents)
    os.chmod(staging, entry["mode"], follow_symlinks=False)
    expected_subtree = manifest_subtree(source_manifest, encoded)
    if subtree_manifest_absolute(staging, encoded) != expected_subtree:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(f"staged transaction subtree changed during {context}")
    item["state"] = "staged"
    write_evidence(path, journal)
    return item


def stage_existing_entry(
    path: Path,
    journal: dict[str, Any],
    encoded: str,
    staging: bytes,
    context: str,
    phase: str,
    subtree: bool = False,
) -> dict[str, Any]:
    item = new_evidence(
        path,
        journal,
        encoded,
        context,
        phase,
        staging=staging,
        subtree=subtree,
    )
    item["state"] = "staged"
    write_evidence(path, journal)
    return item


def install_staged_entry(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    item: dict[str, Any],
    expected: dict[str, Any],
    context: str,
    phase: str,
    expected_subtree: list[dict[str, Any]] | None = None,
) -> None:
    encoded = item["path"]
    staging = os.fsencode(item["staging"])
    target = safe_absolute(root, decode_path(encoded))
    parent = os.path.dirname(target)
    try:
        parent_metadata = os.lstat(parent)
    except FileNotFoundError as error:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(conflict_message(encoded, context)) from error
    if not stat.S_ISDIR(parent_metadata.st_mode):
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(conflict_message(encoded, context))
    before_live_rename(root, encoded, f"{context} install")
    try:
        rename_noreplace_same_device(staging, target)
    except (OSError, RuntimeError) as error:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(conflict_message(encoded, context)) from error
    item["state"] = "installed"
    item["staging"] = None
    write_evidence(path, journal)
    entry_matches = entry_at(root, encoded) == expected
    subtree_matches = (
        expected_subtree is None
        or subtree_manifest(root, encoded) == expected_subtree
    )
    if not entry_matches or not subtree_matches:
        item["state"] = "conflict"
        write_evidence(path, journal)
        raise TransactionConflict(conflict_message(encoded, context))
    mark_operation_complete(path, journal, encoded, phase)


def quarantine_only(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    encoded: str,
    expected: dict[str, Any],
    context: str,
    phase: str,
) -> dict[str, Any]:
    item = quarantine_live_entry(path, journal, root, encoded, expected, context, phase)
    mark_operation_complete(path, journal, encoded, phase)
    return item


def install_from_source(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    source_root: bytes,
    entry: dict[str, Any],
    context: str,
    phase: str,
) -> None:
    item = stage_manifest_entry(path, journal, root, source_root, entry, context, phase)
    install_staged_entry(path, journal, root, item, entry, context, phase)


def promote_loaded(path: Path, journal: dict[str, Any], root: bytes, mirror: bytes, pointer: Path) -> None:
    if journal.get("state") != "prepared" or journal.get("prepared") is None:
        raise RuntimeError("transaction has not been prepared")
    if make_manifest(mirror) != journal["prepared"]:
        raise RuntimeError("transaction workspace changed after preparation")
    drift = verify_live_baseline(journal, root)
    if drift:
        raise TransactionDrift("live checkout drifted at: " + ", ".join(os.fsdecode(decode_path(item)) for item in drift))

    baseline = manifest_map(journal["baseline"])
    prepared = manifest_map(journal["prepared"])
    changed = journal["changed"]
    journal["state"] = "applying"
    json_dump_atomic(path, journal)

    readonly_candidates = [
        encoded
        for encoded, before in baseline.items()
        if before["kind"] == "dir"
        and not before["mode"] & 0o200
        and prepared.get(encoded) is not None
        and prepared[encoded]["kind"] == "dir"
        and any(
            decode_path(item) != decode_path(encoded)
            and path_under(decode_path(item), decode_path(encoded))
            for item in changed
        )
    ]
    subtree_replacements = [
        encoded
        for encoded in readonly_candidates
        if not any(
            decode_path(encoded) != decode_path(parent)
            and path_under(decode_path(encoded), decode_path(parent))
            for parent in readonly_candidates
        )
    ]
    for encoded in sorted(subtree_replacements, key=lambda item: (depth(item), item)):
        entry = prepared[encoded]
        staged_subtree = stage_directory_subtree(
            path,
            journal,
            root,
            mirror,
            journal["prepared"],
            entry,
            "promotion subtree staging",
            "promotion",
        )
        quarantine_live_entry(
            path,
            journal,
            root,
            encoded,
            baseline[encoded],
            "promotion subtree replacement",
            "promotion",
            manifest_subtree(journal["baseline"], encoded),
        )
        install_staged_entry(
            path,
            journal,
            root,
            staged_subtree,
            entry,
            "promotion subtree replacement",
            "promotion",
            manifest_subtree(journal["prepared"], encoded),
        )

    changed = [
        encoded
        for encoded in changed
        if not any(
            path_under(decode_path(encoded), decode_path(parent))
            for parent in subtree_replacements
        )
    ]
    staged: dict[str, dict[str, Any]] = {}
    install_entries = [
        entry
        for encoded, entry in prepared.items()
        if encoded in changed
        and entry["kind"] != "dir"
    ]
    for entry in install_entries:
        staged_entry = dict(entry)
        if staged_entry["kind"] == "dir":
            staged_entry["mode"] = 0o700
        staged[entry["path"]] = stage_manifest_entry(
            path,
            journal,
            root,
            mirror,
            staged_entry,
            "promotion staging",
            "promotion",
        )
        journal["active"] = None
        journal["active_started"] = False
        write_evidence(path, journal)

    removals = [
        encoded
        for encoded in changed
        if baseline.get(encoded) is not None
        and (
            prepared.get(encoded) is None
            or prepared[encoded]["kind"] != baseline[encoded]["kind"]
        )
    ]
    structural_candidates = [
        encoded
        for encoded in removals
        if baseline[encoded]["kind"] == "dir"
    ]
    structural_roots = [
        encoded
        for encoded in structural_candidates
        if not any(
            decode_path(encoded) != decode_path(parent)
            and path_under(decode_path(encoded), decode_path(parent))
            for parent in structural_candidates
        )
    ]
    for encoded in sorted(structural_roots, key=lambda item: (depth(item), item)):
        quarantine_live_entry(
            path,
            journal,
            root,
            encoded,
            baseline[encoded],
            "promotion subtree removal",
            "promotion",
            manifest_subtree(journal["baseline"], encoded),
        )
        mark_operation_complete(path, journal, encoded, "promotion")

    leaf_removals = [
        encoded
        for encoded in removals
        if not any(
            path_under(decode_path(encoded), decode_path(parent))
            for parent in structural_roots
        )
    ]
    for encoded in sorted(leaf_removals, key=lambda item: (depth(item), item), reverse=True):
        quarantine_only(
            path,
            journal,
            root,
            encoded,
            baseline[encoded],
            "promotion removal",
            "promotion",
        )

    directories = [
        entry
        for encoded, entry in prepared.items()
        if encoded in changed and entry["kind"] == "dir"
    ]
    for entry in sorted(directories, key=lambda item: (depth(item["path"]), item["path"])):
        before = baseline.get(entry["path"])
        if before is not None and before["kind"] == "dir":
            continue
        installed_entry = dict(entry)
        installed_entry["mode"] = 0o700
        staged_directory = stage_manifest_entry(
            path,
            journal,
            root,
            mirror,
            installed_entry,
            "promotion directory staging",
            "promotion",
        )
        install_staged_entry(
            path,
            journal,
            root,
            staged_directory,
            installed_entry,
            "promotion directory creation",
            "promotion",
        )

    leaves = [entry for encoded, entry in prepared.items() if encoded in changed and entry["kind"] != "dir"]
    for entry in sorted(leaves, key=lambda item: (depth(item["path"]), item["path"])):
        before = baseline.get(entry["path"])
        if before is not None and before["kind"] == entry["kind"]:
            quarantine_only(
                path,
                journal,
                root,
                entry["path"],
                before,
                "promotion replacement",
                "promotion",
            )
        install_staged_entry(
            path,
            journal,
            root,
            staged[entry["path"]],
            entry,
            "promotion replacement",
            "promotion",
        )

    for entry in sorted(directories, key=lambda item: (depth(item["path"]), item["path"]), reverse=True):
        before = baseline.get(entry["path"])
        if before is not None and before["kind"] == "dir":
            expected = before
        else:
            expected = dict(entry)
            expected["mode"] = 0o700
        if expected == entry:
            continue
        quarantined = quarantine_live_entry(
            path,
            journal,
            root,
            entry["path"],
            expected,
            "promotion mode change",
            "promotion",
        )
        quarantine = os.fsencode(quarantined["quarantine"])
        os.chmod(quarantine, entry["mode"], follow_symlinks=False)
        if entry_at_absolute(quarantine, entry["path"]) != entry:
            quarantined["state"] = "conflict"
            write_evidence(path, journal)
            raise TransactionConflict(conflict_message(entry["path"], "promotion mode change"))
        staging_item = stage_existing_entry(
            path,
            journal,
            entry["path"],
            quarantine,
            "promotion mode change",
            "promotion",
        )
        install_staged_entry(
            path,
            journal,
            root,
            staging_item,
            entry,
            "promotion mode change",
            "promotion",
        )

    journal["state"] = "committed"
    journal["active"] = None
    journal["active_started"] = False
    json_dump_atomic(path, journal)
    remove_transaction(
        path,
        pointer,
        mirror,
        os.fsencode(journal["quarantine_root"]),
        journal["evidence"],
        "committed",
    )


def promote_command(args: argparse.Namespace) -> int:
    path, journal, root, _, mirror, pointer = load_bound_journal(args)
    promote_loaded(path, journal, root, mirror, pointer)
    return 0


def recovery_paths(journal: dict[str, Any]) -> list[str]:
    result: list[str] = []
    active = [journal["active"]] if journal.get("active") and journal.get("active_started") else []
    evidence = [item["path"] for item in journal.get("evidence", [])]
    for encoded in journal.get("promoted", []) + active + evidence:
        if encoded not in result:
            result.append(encoded)
    return result


def validate_recovery_state(
    journal: dict[str, Any],
    root: bytes,
    affected: list[str],
) -> tuple[dict[str, dict[str, Any] | None], set[str]]:
    baseline = manifest_map(journal["baseline"])
    prepared = manifest_map(journal["prepared"] or [])
    affected_bytes = {decode_path(item) for item in affected}
    observed: dict[str, dict[str, Any] | None] = {}
    conflicts: set[str] = set()
    subtree_paths = {
        item["path"]
        for item in journal.get("evidence", [])
        if item.get("subtree", False)
    }
    for encoded in affected:
        current = entry_at(root, encoded)
        observed[encoded] = current
        allowed = [None, baseline.get(encoded), prepared.get(encoded)]
        temporary_directory = prepared.get(encoded)
        if temporary_directory is not None and temporary_directory["kind"] == "dir":
            temporary_directory = {**temporary_directory, "mode": 0o700}
            allowed.append(temporary_directory)
        if current not in allowed:
            conflicts.add(encoded)
            continue
        if current is not None and encoded in subtree_paths:
            current_subtree = subtree_manifest(root, encoded)
            if current_subtree not in (
                manifest_subtree(journal["baseline"], encoded),
                manifest_subtree(journal["prepared"] or [], encoded),
            ):
                conflicts.add(encoded)
                continue
        if current is not None and current["kind"] == "dir" and baseline.get(encoded) is None:
            for entry in subtree_manifest(root, encoded)[1:]:
                rel = decode_path(entry["path"])
                if rel not in affected_bytes or prepared.get(entry["path"]) != entry:
                    conflicts.add(encoded)
                    break
    return observed, conflicts


def record_recovery_conflict(
    path: Path,
    journal: dict[str, Any],
    encoded: str,
    context: str,
) -> None:
    journal["evidence"].append({
        "id": uuid.uuid4().hex,
        "path": encoded,
        "context": context,
        "phase": "recovery",
        "state": "conflict",
        "quarantine": None,
        "staging": None,
    })
    journal["active"] = None
    journal["active_started"] = False
    write_evidence(path, journal)


def path_blocked(encoded: str, conflicts: set[str]) -> bool:
    rel = decode_path(encoded)
    return any(path_under(rel, decode_path(conflict)) for conflict in conflicts)


def quarantined_baseline(
    journal: dict[str, Any],
    encoded: str,
    expected: dict[str, Any],
) -> bytes | None:
    for item in reversed(journal.get("evidence", [])):
        if item.get("path") != encoded or item.get("quarantine") is None:
            continue
        candidate = os.fsencode(item["quarantine"])
        matches = entry_at_absolute(candidate, encoded) == expected
        if matches and expected["kind"] == "dir":
            matches = (
                subtree_manifest_absolute(candidate, encoded)
                == manifest_subtree(journal["baseline"], encoded)
            )
        if matches:
            return candidate
    return None


def quarantined_directory(
    journal: dict[str, Any],
    encoded: str,
) -> bytes | None:
    for item in reversed(journal.get("evidence", [])):
        if item.get("path") != encoded or item.get("quarantine") is None:
            continue
        candidate = os.fsencode(item["quarantine"])
        current = entry_at_absolute(candidate, encoded)
        if current is not None and current["kind"] == "dir":
            return candidate
    return None


def restore_baseline_entry(
    path: Path,
    journal: dict[str, Any],
    root: bytes,
    baseline_store: bytes,
    entry: dict[str, Any],
    context: str,
    subtree: bool = False,
) -> None:
    candidate = quarantined_baseline(journal, entry["path"], entry)
    if candidate is None and entry["kind"] == "dir" and not subtree:
        candidate = quarantined_directory(journal, entry["path"])
        if candidate is not None:
            os.chmod(candidate, entry["mode"], follow_symlinks=False)
            if entry_at_absolute(candidate, entry["path"]) != entry:
                raise TransactionConflict(
                    conflict_message(entry["path"], "recovery directory staging")
                )
    if candidate is None:
        if subtree and entry["kind"] == "dir":
            item = stage_directory_subtree(
                path,
                journal,
                root,
                baseline_store,
                journal["baseline"],
                entry,
                context,
                "recovery",
            )
        else:
            item = stage_manifest_entry(
                path,
                journal,
                root,
                baseline_store,
                entry,
                context,
                "recovery",
            )
    else:
        item = stage_existing_entry(
            path,
            journal,
            entry["path"],
            candidate,
            context,
            "recovery",
            subtree,
        )
    expected_subtree = manifest_subtree(journal["baseline"], entry["path"]) if subtree else None
    install_staged_entry(
        path,
        journal,
        root,
        item,
        entry,
        context,
        "recovery",
        expected_subtree,
    )


def restore_affected(path: Path, journal: dict[str, Any], root: bytes) -> None:
    affected = recovery_paths(journal)
    observed, conflicts = validate_recovery_state(journal, root, affected)
    baseline = manifest_map(journal["baseline"])
    prepared = manifest_map(journal["prepared"] or [])
    baseline_store = os.fsencode(journal["baseline_store"])
    subtree_paths = {
        item["path"]
        for item in journal.get("evidence", [])
        if item.get("subtree", False)
    }
    journal["state"] = "recovering"
    journal["active"] = None
    journal["active_started"] = False
    write_evidence(path, journal)

    for encoded in sorted(conflicts):
        record_recovery_conflict(path, journal, encoded, "recovery validation")

    removals: list[str] = []
    for encoded in affected:
        current = observed[encoded]
        before = baseline.get(encoded)
        if current is not None and (
            before is None or current["kind"] != before["kind"]
        ):
            removals.append(encoded)
    for encoded in sorted(removals, key=lambda item: (depth(item), item), reverse=True):
        if path_blocked(encoded, conflicts):
            continue
        current = observed[encoded]
        if current is None:
            raise RuntimeError("recovery removal entry disappeared from observed state")
        expected_subtree = None
        if current["kind"] == "dir":
            expected_subtree = subtree_manifest(root, encoded)
        try:
            if expected_subtree is None:
                quarantine_only(
                    path,
                    journal,
                    root,
                    encoded,
                    current,
                    "recovery removal",
                    "recovery",
                )
            else:
                quarantine_live_entry(
                    path,
                    journal,
                    root,
                    encoded,
                    current,
                    "recovery removal",
                    "recovery",
                    expected_subtree,
                )
                mark_operation_complete(path, journal, encoded, "recovery")
        except TransactionConflict:
            conflicts.add(encoded)
            continue
        observed[encoded] = None

    directories = [baseline[encoded] for encoded in affected if encoded in baseline and baseline[encoded]["kind"] == "dir"]
    for entry in sorted(directories, key=lambda item: (depth(item["path"]), item["path"])):
        encoded = entry["path"]
        if path_blocked(encoded, conflicts):
            continue
        current = entry_at(root, encoded)
        baseline_subtree = manifest_subtree(journal["baseline"], encoded)
        current_subtree = subtree_manifest(root, encoded) if current is not None else []
        subtree = encoded in subtree_paths
        if current == entry and (not subtree or current_subtree == baseline_subtree):
            observed[encoded] = entry
            continue
        try:
            if current is None:
                restore_baseline_entry(
                    path,
                    journal,
                    root,
                    baseline_store,
                    entry,
                    "recovery directory restoration",
                    subtree,
                )
            elif (
                subtree
                and current["kind"] == "dir"
                and current_subtree == manifest_subtree(journal["prepared"] or [], encoded)
            ):
                quarantine_live_entry(
                    path,
                    journal,
                    root,
                    encoded,
                    current,
                    "recovery subtree replacement",
                    "recovery",
                    current_subtree,
                )
                mark_operation_complete(path, journal, encoded, "recovery")
                restore_baseline_entry(
                    path,
                    journal,
                    root,
                    baseline_store,
                    entry,
                    "recovery subtree restoration",
                    True,
                )
            elif current["kind"] == "dir" and current in (
                prepared.get(encoded),
                {**prepared[encoded], "mode": 0o700} if encoded in prepared and prepared[encoded]["kind"] == "dir" else None,
            ):
                quarantined = quarantine_live_entry(
                    path,
                    journal,
                    root,
                    encoded,
                    current,
                    "recovery mode restoration",
                    "recovery",
                )
                quarantine = os.fsencode(quarantined["quarantine"])
                os.chmod(quarantine, entry["mode"], follow_symlinks=False)
                if entry_at_absolute(quarantine, encoded) != entry:
                    quarantined["state"] = "conflict"
                    write_evidence(path, journal)
                    raise TransactionConflict(conflict_message(encoded, "recovery mode restoration"))
                item = stage_existing_entry(
                    path,
                    journal,
                    encoded,
                    quarantine,
                    "recovery mode restoration",
                    "recovery",
                )
                install_staged_entry(
                    path,
                    journal,
                    root,
                    item,
                    entry,
                    "recovery mode restoration",
                    "recovery",
                )
            else:
                record_recovery_conflict(path, journal, encoded, "recovery directory restoration")
                conflicts.add(encoded)
                continue
        except TransactionConflict:
            conflicts.add(encoded)
            continue
        observed[encoded] = entry

    leaves = [baseline[encoded] for encoded in affected if encoded in baseline and baseline[encoded]["kind"] != "dir"]
    for entry in sorted(leaves, key=lambda item: (depth(item["path"]), item["path"])):
        encoded = entry["path"]
        if path_blocked(encoded, conflicts):
            continue
        current = entry_at(root, encoded)
        if current == entry:
            observed[encoded] = entry
            continue
        if current not in (None, prepared.get(encoded)):
            record_recovery_conflict(path, journal, encoded, "recovery replacement")
            conflicts.add(encoded)
            continue
        try:
            if current is not None:
                quarantine_only(
                    path,
                    journal,
                    root,
                    encoded,
                    current,
                    "recovery replacement",
                    "recovery",
                )
            restore_baseline_entry(
                path,
                journal,
                root,
                baseline_store,
                entry,
                "recovery replacement",
            )
        except TransactionConflict:
            conflicts.add(encoded)
            continue
        observed[encoded] = entry

    if conflicts:
        journal["state"] = "conflicted"
        journal["active"] = None
        journal["active_started"] = False
        write_evidence(path, journal)
        rendered = ", ".join(
            os.fsdecode(decode_path(encoded)) for encoded in sorted(conflicts)
        )
        raise TransactionConflict(f"recovery retained conflict evidence for: {rendered}")
    journal["state"] = "recovered"
    journal["active"] = None
    journal["active_started"] = False
    json_dump_atomic(path, journal)


def discard_command(args: argparse.Namespace) -> int:
    path, journal, root, _, mirror, pointer = load_bound_journal(args)
    if journal.get("state") in ("applying", "recovering", "conflicted"):
        restore_affected(path, journal, root)
    elif journal.get("state") == "committed":
        raise RuntimeError("committed transaction cannot be discarded")
    cleanup_state = "recovered" if journal.get("state") == "recovered" else "discarded"
    remove_transaction(
        path,
        pointer,
        mirror,
        os.fsencode(journal["quarantine_root"]),
        journal["evidence"],
        cleanup_state,
    )
    return 0


def recover_command(args: argparse.Namespace) -> int:
    root, runtime, metadata_root, pointer = caller_identity(args)
    if not os.path.lexists(pointer):
        return 0
    data = pointer_data(pointer)
    journal_path = pointer_journal_path(data, root, runtime, metadata_root)
    if not os.path.lexists(journal_path):
        if data.get("terminal") not in ("committed", "recovered", "discarded"):
            raise RuntimeError("nonterminal transaction journal is missing")
        if os.path.lexists(journal_path.parent):
            owned_private_directory(journal_path.parent, "transaction directory")
            remove_tree(journal_path.parent)
        unlink_pointer_durable(pointer)
        return 0
    path, journal, bound_root, _, mirror, bound_pointer = load_bound_journal(
        args,
        allow_terminal_cleanup=True,
    )
    if bound_root != root:
        raise RuntimeError("transaction recovery root mismatch")
    state = journal.get("state")
    if state in ("applying", "recovering", "conflicted"):
        restore_affected(path, journal, bound_root)
    elif state not in ("mirrored", "prepared", "committed", "recovered"):
        raise RuntimeError("transaction journal has an invalid recovery state")
    cleanup_state = journal.get("state")
    if cleanup_state not in ("committed", "recovered"):
        cleanup_state = "discarded"
    remove_transaction(
        path,
        bound_pointer,
        mirror,
        os.fsencode(journal["quarantine_root"]),
        journal["evidence"],
        cleanup_state,
    )
    return 0


def add_identity_arguments(parser: argparse.ArgumentParser, include_journal: bool = True) -> None:
    parser.add_argument("--root", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--metadata-root", required=True)
    parser.add_argument("--pointer", required=True)
    if include_journal:
        parser.add_argument("--journal", required=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="subcommand", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--root", required=True)
    snapshot.add_argument("--runtime", required=True)
    snapshot.add_argument("--output", required=True)
    snapshot.set_defaults(func=snapshot_command)

    pointer_path = subparsers.add_parser("pointer-path")
    pointer_path.add_argument("--root", required=True)
    pointer_path.add_argument("--runtime", required=True)
    pointer_path.add_argument("--metadata-root", required=True)
    pointer_path.set_defaults(func=pointer_path_command)

    mirror = subparsers.add_parser("mirror")
    add_identity_arguments(mirror, include_journal=False)
    mirror.set_defaults(func=mirror_command)

    for name, function in (
        ("workspace", workspace_command),
        ("diff", diff_command),
        ("prepare", prepare_command),
        ("verify", verify_command),
        ("promote", promote_command),
        ("discard", discard_command),
    ):
        command = subparsers.add_parser(name)
        add_identity_arguments(command)
        command.set_defaults(func=function)

    recover = subparsers.add_parser("recover")
    add_identity_arguments(recover, include_journal=False)
    recover.set_defaults(func=recover_command)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return args.func(args)
    except TransactionDrift as error:
        print(f"ralph_fs_txn: {error}", file=sys.stderr)
        return 3
    except (KeyError, OSError, RuntimeError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ralph_fs_txn: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
