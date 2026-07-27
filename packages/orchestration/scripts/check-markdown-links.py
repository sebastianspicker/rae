#!/usr/bin/env python3

"""Validate local Markdown links and heading anchors without network access."""

import argparse
import fnmatch
import re
import sys
from functools import lru_cache
from pathlib import Path

INLINE_LINK_RE = re.compile(r"!\[[^\]]*]\(([^)]+)\)|\[[^\]]+]\(([^)]+)\)")
REFERENCE_DEF_RE = re.compile(r"^\s*\[([^\]]+)]:\s*(\S+)\s*$")
REFERENCE_USE_RE = re.compile(r"(?<!!)\[([^\]]+)\]\[([^\]]*)\]")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*$")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _strip_code_fences(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    for line in lines:
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


def _normalize_ref_label(label: str) -> str:
    return re.sub(r"\s+", " ", label.strip().lower())


def _extract_target(raw: str) -> str:
    target = raw.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1].strip()
    if " " in target:
        target = target.split(" ", 1)[0]
    return target


def _is_external(target: str) -> bool:
    if target.startswith("//"):
        return True
    return SCHEME_RE.match(target) is not None


def _slugify(text: str) -> str:
    value = text.strip().lower()
    value = re.sub(r"[^\w\s-]", "", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


@lru_cache(maxsize=512)
def _anchors_for_file(path: Path) -> set[str]:
    anchors: set[str] = set()
    if not path.exists() or not path.is_file():
        return anchors
    try:
        text = _strip_code_fences(_read_text(path))
    except OSError:
        return anchors
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        heading = match.group(1).strip()
        if not heading:
            continue
        anchors.add(_slugify(heading))
    return anchors


def _iter_markdown_files(root: Path, excludes: list[str]) -> list[Path]:
    candidates = [root / "README.md", root / "AGENTS.md", root / "CONTRIBUTING.md"]
    docs_root = root / "docs"
    if docs_root.exists():
        candidates.extend(sorted(docs_root.rglob("*.md")))

    seen: set[Path] = set()
    out: list[Path] = []
    for file in candidates:
        if not file.exists() or not file.is_file():
            continue
        if file in seen:
            continue
        rel = file.relative_to(root).as_posix()
        if any(fnmatch.fnmatch(rel, pattern) for pattern in excludes):
            continue
        seen.add(file)
        out.append(file)
    return out


def _validate_same_file_anchor(source_file: Path, anchor: str, root: Path) -> str | None:
    if not anchor:
        return None
    if anchor not in _anchors_for_file(source_file):
        return f"missing anchor '#{anchor}' in {source_file.relative_to(root)}"
    return None


def _resolve_destination(
    source_file: Path, target: str, root: Path, allowed_root: Path
) -> tuple[Path | None, str, str | None]:
    path_part, _, anchor = target.partition("#")
    destination = (source_file.parent / path_part).resolve(strict=False)
    try:
        destination.relative_to(allowed_root.resolve(strict=False))
    except ValueError:
        return None, anchor, f"target escapes repository root: {target}"
    return destination, anchor, None


def _validate_destination_anchor(
    destination: Path, anchor: str, target: str, root: Path
) -> str | None:
    if not anchor:
        return None
    if not destination.is_file():
        return f"anchor '#{anchor}' points to non-file target: {target}"
    if anchor not in _anchors_for_file(destination):
        try:
            display = destination.relative_to(root)
        except ValueError:
            display = destination
        return f"missing anchor '#{anchor}' in {display}"
    return None


def _validate_local_target(
    source_file: Path,
    target: str,
    root: Path,
    allowed_root: Path,
    strict: bool,
) -> str | None:
    destination, anchor, error = _resolve_destination(
        source_file, target, root, allowed_root
    )
    if error:
        return error
    if destination is None:
        return f"could not resolve target: {target}"
    if not destination.exists():
        return f"missing target: {target}"
    if not strict:
        return None
    return _validate_destination_anchor(destination, anchor, target, root)


def _validate_target(
    source_file: Path,
    target: str,
    root: Path,
    allowed_root: Path,
    strict: bool,
) -> str | None:
    if not target:
        return "empty link target"
    if target.startswith("#"):
        return _validate_same_file_anchor(source_file, target[1:], root) if strict else None
    if _is_external(target):
        return None
    return _validate_local_target(source_file, target, root, allowed_root, strict)


def _reference_definitions(text: str) -> dict[str, str]:
    definitions: dict[str, str] = {}
    for line in text.splitlines():
        match = REFERENCE_DEF_RE.match(line)
        if match:
            definitions[_normalize_ref_label(match.group(1))] = _extract_target(match.group(2))
    return definitions


def _inline_link_errors(
    path: Path, text: str, root: Path, allowed_root: Path, strict: bool
) -> list[str]:
    errors: list[str] = []
    for match in INLINE_LINK_RE.finditer(text):
        target = _extract_target(match.group(1) or match.group(2) or "")
        if error := _validate_target(path, target, root, allowed_root, strict):
            errors.append(f"{path.relative_to(root)}: {error}")
    return errors


def _reference_link_errors(
    path: Path,
    text: str,
    root: Path,
    allowed_root: Path,
    strict: bool,
    definitions: dict[str, str],
) -> list[str]:
    errors: list[str] = []
    for match in REFERENCE_USE_RE.finditer(text):
        label = _normalize_ref_label(match.group(2) or match.group(1))
        target = definitions.get(label)
        if target is None:
            errors.append(f"{path.relative_to(root)}: missing reference definition [{label}]")
        elif error := _validate_target(path, target, root, allowed_root, strict):
            errors.append(f"{path.relative_to(root)}: {error}")
    return errors


def _check_file(
    path: Path, root: Path, allowed_root: Path, strict: bool
) -> list[str]:
    text = _strip_code_fences(_read_text(path))
    definitions = _reference_definitions(text)
    return _inline_link_errors(path, text, root, allowed_root, strict) + _reference_link_errors(
        path, text, root, allowed_root, strict, definitions
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Check relative markdown links.")
    parser.add_argument("--root", default=".", help="Repository root (default: current directory)")
    parser.add_argument(
        "--allowed-root",
        help="Outer boundary allowed for local link targets (default: --root)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Validate local anchors (#fragment) in markdown files",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Glob pattern (repo-relative) to exclude, can be repeated",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve(strict=False)
    allowed_root = Path(args.allowed_root or args.root).resolve(strict=False)
    if not root.exists():
        print(f"Root does not exist: {root}", file=sys.stderr)
        return 2
    try:
        root.relative_to(allowed_root)
    except ValueError:
        print("Root must be within allowed root.", file=sys.stderr)
        return 2

    files = _iter_markdown_files(root, args.exclude)
    if not files:
        print("No markdown files found for checking.", file=sys.stderr)
        return 2

    all_errors: list[str] = []
    for file in files:
        all_errors.extend(_check_file(file, root, allowed_root, args.strict))

    if all_errors:
        print("FAIL: markdown link check failed:", file=sys.stderr)
        for entry in sorted(set(all_errors)):
            print(f"  - {entry}", file=sys.stderr)
        return 1

    print(f"OK: markdown links validated across {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
