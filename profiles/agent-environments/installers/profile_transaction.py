#!/usr/bin/env python3
"""Transactional installer CLI for the public agent environment profile."""

import argparse
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

from profile_io import (
    NOFOLLOW,
    ProfileError,
    close_fd,
    file_state,
    open_target,
    read_all,
    require_safe_layout,
    test_pause,
)
from profile_receipts import (
    MutationInterrupted,
    MutationReceipt,
    commit_receipts,
    guarded_mutation,
    rollback,
)

INSTALLER_ID = "profiles/agent-environments/installers/install-profile.sh"
MANIFEST_VERSION = 2
SHA256_HEX_LENGTH = 64
FILES = (
    (
        ".codex/config.toml",
        "templates/codex/config.toml",
        ".rae-profile-backups/.codex/config.toml.bak",
    ),
    (
        ".claude/settings.json",
        "templates/claude/settings.json",
        ".rae-profile-backups/.claude/settings.json.bak",
    ),
    (
        "docs/agent-operator-policy.md",
        "shared/policy/operator-policy.md",
        ".rae-profile-backups/docs/agent-operator-policy.md.bak",
    ),
)


def digest_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def valid_hash(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == SHA256_HEX_LENGTH
        and all(char in "0123456789abcdef" for char in value)
    )


def load_sources(profile_root: Path) -> dict[str, bytes]:
    sources = {}
    for relative, source_rel, _ in FILES:
        sources[relative] = load_source(profile_root / source_rel)
    return sources


def load_source(source: Path) -> bytes:
    """Load only a regular, non-symlinked profile source to prevent template substitution."""
    try:
        fd = os.open(source, os.O_RDONLY | NOFOLLOW)
    except OSError as exc:
        raise ProfileError(f"profile source must be a regular file: {source}: {exc}") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ProfileError(f"profile source must be a regular file: {source}")
        return read_all(fd)
    finally:
        close_fd(fd)


def parse_manifest(payload: bytes) -> dict[str, dict[str, str]]:
    """Parse the fixed-shape manifest before trusting installed paths or backup hashes."""
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProfileError(f"invalid profile manifest: {exc}") from exc
    entries = manifest_entries(data)
    expected = {relative: backup for relative, _, backup in FILES}
    parsed = {}
    for entry in entries:
        relative = validate_manifest_entry(entry, expected, parsed)
        parsed[relative] = entry
    if set(parsed) != set(expected):
        raise ProfileError("invalid profile manifest paths")
    return parsed


def manifest_entries(data: object) -> list[dict]:
    fields = {"manifest_version", "installer", "installed_files"}
    if not isinstance(data, dict) or set(data) != fields:
        raise ProfileError("invalid profile manifest fields")
    if data["manifest_version"] != MANIFEST_VERSION or data["installer"] != INSTALLER_ID:
        raise ProfileError("unsupported or invalid profile manifest")
    entries = data["installed_files"]
    if not isinstance(entries, list) or len(entries) != len(FILES):
        raise ProfileError("invalid profile manifest installed_files")
    return entries


def validate_manifest_entry(entry: object, expected: dict[str, str], parsed: dict) -> str:
    fields = {"path", "sha256", "backup_path", "backup_sha256"}
    if not isinstance(entry, dict) or set(entry) != fields:
        raise ProfileError("invalid profile manifest entry fields")
    relative = entry.get("path")
    backup = entry.get("backup_path")
    if not isinstance(relative, str) or not isinstance(backup, str):
        raise ProfileError("invalid profile manifest path")
    if invalid_manifest_location(relative, backup, expected, parsed):
        raise ProfileError("invalid profile manifest path")
    if not valid_manifest_hashes(entry, backup):
        raise ProfileError("invalid profile manifest hash")
    return relative


def invalid_manifest_location(
    relative: str, backup: str, expected: dict[str, str], parsed: dict
) -> bool:
    return relative not in expected or relative in parsed or backup not in {"", expected[relative]}


def valid_manifest_hashes(entry: dict, backup: object) -> bool:
    if not valid_hash(entry.get("sha256")):
        return False
    backup_hash = entry.get("backup_sha256")
    return bool(valid_hash(backup_hash)) if backup else backup_hash == ""


def checked_manifest(root_fd: int) -> dict[str, dict[str, str]] | None:
    """Verify each recorded install and backup digest before a profile mutation proceeds."""
    manifest = file_state(root_fd, ".rae-profile-install.json")
    if not manifest["exists"]:
        return None
    entries = parse_manifest(manifest["data"])
    for relative, entry in entries.items():
        validate_installed_entry(root_fd, relative, entry)
    return entries


def validate_installed_entry(root_fd: int, relative: str, entry: dict[str, str]) -> None:
    installed = file_state(root_fd, relative)
    if not installed["exists"] or digest_bytes(installed["data"]) != entry["sha256"]:
        raise ProfileError(f"installed profile target is missing or modified: {relative}")
    if not entry["backup_path"]:
        return
    backup = file_state(root_fd, entry["backup_path"])
    if not backup["exists"] or digest_bytes(backup["data"]) != entry["backup_sha256"]:
        raise ProfileError(f"original profile backup hash mismatch: {entry['backup_path']}")


def manifest_payload(entries: list[dict[str, str]]) -> bytes:
    data = {
        "manifest_version": MANIFEST_VERSION,
        "installer": INSTALLER_ID,
        "installed_files": entries,
    }
    return (json.dumps(data, indent=2) + "\n").encode()


def install_before(root_fd: int) -> dict[str, dict]:
    before = {relative: file_state(root_fd, relative) for relative, _, _ in FILES}
    before[".rae-profile-install.json"] = file_state(root_fd, ".rae-profile-install.json")
    before.update({backup: file_state(root_fd, backup) for _, _, backup in FILES})
    return before


def reject_unsafe_install(
    existing: dict | None, before: dict[str, dict], force: bool, target: Path
) -> None:
    """Refuse installation states that could overwrite unmanaged files or stale backups."""
    if existing and not force:
        raise ProfileError(f"profile is already installed; use --force to reinstall: {target}")
    if reject_existing_targets(existing, before, force):
        raise ProfileError("refusing to overwrite existing file without --force")
    if reject_stale_backups(existing, before):
        raise ProfileError("refusing to overwrite stale profile backup")


def reject_existing_targets(existing: dict | None, before: dict[str, dict], force: bool) -> bool:
    return (
        not existing and not force and any(before[relative]["exists"] for relative, _, _ in FILES)
    )


def reject_stale_backups(existing: dict | None, before: dict[str, dict]) -> bool:
    return not existing and any(before[backup]["exists"] for _, _, backup in FILES)


def install_entries(
    sources: dict[str, bytes], before: dict[str, dict], existing: dict | None
) -> list[dict[str, str]]:
    return [
        install_entry(relative, backup, sources, before, existing) for relative, _, backup in FILES
    ]


def install_entry(
    relative: str,
    backup: str,
    sources: dict[str, bytes],
    before: dict[str, dict],
    existing: dict | None,
) -> dict[str, str]:
    old = before[relative]
    saved = existing[relative] if existing else None
    return {
        "path": relative,
        "sha256": digest_bytes(sources[relative]),
        "backup_path": saved["backup_path"] if saved else (backup if old["exists"] else ""),
        "backup_sha256": saved["backup_sha256"]
        if saved
        else (digest_bytes(old["data"]) if old["exists"] else ""),
    }


def register_mutation(
    receipts: list[MutationReceipt],
    root_fd: int,
    relative: str,
    expected: dict,
    replacement: bytes | None,
    action: str,
) -> None:
    try:
        receipt = guarded_mutation(root_fd, relative, expected, replacement, action)
    except MutationInterrupted as exc:
        receipts.append(exc.receipt)
        raise
    receipts.append(receipt)


def apply_install(
    root_fd: int,
    sources: dict[str, bytes],
    before: dict[str, dict],
    entries: list[dict[str, str]],
    existing: dict | None,
) -> None:
    receipts = []
    try:
        register_backups(receipts, root_fd, before, entries, existing)
        for relative, _, _ in FILES:
            register_mutation(
                receipts, root_fd, relative, before[relative], sources[relative], "install"
            )
        test_pause("install-after-files")
        register_mutation(
            receipts,
            root_fd,
            ".rae-profile-install.json",
            before[".rae-profile-install.json"],
            manifest_payload(entries),
            "install",
        )
        commit_receipts(root_fd, receipts, "install")
    except Exception:
        rollback(root_fd, receipts)
        raise


def register_backups(
    receipts: list[MutationReceipt],
    root_fd: int,
    before: dict[str, dict],
    entries: list[dict[str, str]],
    existing: dict | None,
) -> None:
    if existing:
        return
    for entry in entries:
        if entry["backup_path"]:
            register_mutation(
                receipts,
                root_fd,
                entry["backup_path"],
                before[entry["backup_path"]],
                before[entry["path"]]["data"],
                "install",
            )


def install(profile_root: Path, target: Path, force: bool) -> None:
    sources = load_sources(profile_root)
    root_fd = open_target(target)
    try:
        require_safe_layout(root_fd)
        existing = checked_manifest(root_fd)
        before = install_before(root_fd)
        reject_unsafe_install(existing, before, force, target)
        apply_install(
            root_fd, sources, before, install_entries(sources, before, existing), existing
        )
    finally:
        close_fd(root_fd)


def uninstall_before(root_fd: int, entries: dict[str, dict[str, str]]) -> dict[str, dict]:
    before = {relative: file_state(root_fd, relative) for relative in entries}
    before[".rae-profile-install.json"] = file_state(root_fd, ".rae-profile-install.json")
    before.update(
        {
            entry["backup_path"]: file_state(root_fd, entry["backup_path"])
            for entry in entries.values()
            if entry["backup_path"]
        }
    )
    return before


def apply_uninstall(
    root_fd: int, entries: dict[str, dict[str, str]], before: dict[str, dict]
) -> None:
    receipts = []
    try:
        register_uninstall_targets(receipts, root_fd, entries, before)
        test_pause("uninstall-after-files")
        register_mutation(
            receipts,
            root_fd,
            ".rae-profile-install.json",
            before[".rae-profile-install.json"],
            None,
            "uninstall",
        )
        register_backup_removals(receipts, root_fd, entries, before)
        commit_receipts(root_fd, receipts, "uninstall")
    except Exception:
        rollback(root_fd, receipts)
        raise


def register_uninstall_targets(
    receipts: list[MutationReceipt],
    root_fd: int,
    entries: dict[str, dict[str, str]],
    before: dict[str, dict],
) -> None:
    for relative, entry in entries.items():
        replacement = before[entry["backup_path"]]["data"] if entry["backup_path"] else None
        register_mutation(receipts, root_fd, relative, before[relative], replacement, "uninstall")


def register_backup_removals(
    receipts: list[MutationReceipt],
    root_fd: int,
    entries: dict[str, dict[str, str]],
    before: dict[str, dict],
) -> None:
    for entry in entries.values():
        if entry["backup_path"]:
            backup = entry["backup_path"]
            register_mutation(receipts, root_fd, backup, before[backup], None, "uninstall")


def uninstall(target: Path) -> bool:
    root_fd = open_target(target)
    try:
        require_safe_layout(root_fd)
        entries = checked_manifest(root_fd)
        if not entries:
            return False
        apply_uninstall(root_fd, entries, uninstall_before(root_fd, entries))
        return True
    finally:
        close_fd(root_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--profile-root", type=Path)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("target", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.action == "install" and args.profile_root is None:
        raise ProfileError("--profile-root is required for install")
    if args.action == "uninstall" and not args.target.exists():
        print(f"no installed profile found in {args.target}")
        return 0
    if args.action == "install":
        install(args.profile_root.resolve(), args.target, args.force)
        print(f"installed profile into {args.target}")
    elif uninstall(args.target):
        print(f"removed profile from {args.target}")
    else:
        print(f"no installed profile found in {args.target}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProfileError as exc:
        print(f"refusing profile operation: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
