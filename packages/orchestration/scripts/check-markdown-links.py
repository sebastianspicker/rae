#!/usr/bin/env python3

from __future__ import annotations

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
    candidates = [root / "README.md", root / "AGENTS.md"]
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


def _validate_target(
    source_file: Path,
    target: str,
    root: Path,
    strict: bool,
) -> str | None:
    if not target:
        return "empty link target"
    if target.startswith("#"):
        if not strict:
            return None
        anchor = target[1:]
        anchors = _anchors_for_file(source_file)
        if anchor and anchor not in anchors:
            return f"missing anchor '#{anchor}' in {source_file.relative_to(root)}"
        return None
    if _is_external(target):
        return None

    path_part, _, anchor = target.partition("#")
    dest = (source_file.parent / path_part).resolve(strict=False)
    root_real = root.resolve(strict=False)
    try:
        dest.relative_to(root_real)
    except ValueError:
        return f"target escapes repository root: {target}"

    if not dest.exists():
        return f"missing target: {target}"

    if strict and anchor:
        if not dest.is_file():
            return f"anchor '#{anchor}' points to non-file target: {target}"
        anchors = _anchors_for_file(dest)
        if anchor not in anchors:
            return f"missing anchor '#{anchor}' in {dest.relative_to(root)}"
    return None


def _check_file(path: Path, root: Path, strict: bool) -> list[str]:
    text = _strip_code_fences(_read_text(path))
    errors: list[str] = []

    reference_defs: dict[str, str] = {}
    for line in text.splitlines():
        match = REFERENCE_DEF_RE.match(line)
        if not match:
            continue
        label = _normalize_ref_label(match.group(1))
        target = _extract_target(match.group(2))
        reference_defs[label] = target

    for match in INLINE_LINK_RE.finditer(text):
        raw = match.group(1) or match.group(2) or ""
        target = _extract_target(raw)
        error = _validate_target(path, target, root, strict)
        if error:
            errors.append(f"{path.relative_to(root)}: {error}")

    for match in REFERENCE_USE_RE.finditer(text):
        label = _normalize_ref_label(match.group(2) or match.group(1))
        target = reference_defs.get(label)
        if not target:
            errors.append(f"{path.relative_to(root)}: missing reference definition [{label}]")
            continue
        error = _validate_target(path, target, root, strict)
        if error:
            errors.append(f"{path.relative_to(root)}: {error}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Check relative markdown links.")
    parser.add_argument("--root", default=".", help="Repository root (default: current directory)")
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
    if not root.exists():
        print(f"Root does not exist: {root}", file=sys.stderr)
        return 2

    files = _iter_markdown_files(root, args.exclude)
    if not files:
        print("No markdown files found for checking.", file=sys.stderr)
        return 2

    all_errors: list[str] = []
    for file in files:
        all_errors.extend(_check_file(file, root, args.strict))

    if all_errors:
        print("FAIL: markdown link check failed:", file=sys.stderr)
        for entry in sorted(set(all_errors)):
            print(f"  - {entry}", file=sys.stderr)
        return 1

    print(f"OK: markdown links validated across {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
