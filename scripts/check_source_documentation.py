#!/usr/bin/env python3
"""Require purpose-and-rationale headers on hand-maintained executable sources."""

from __future__ import annotations

import ast
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_ROOTS = ("scripts", "evals", "packages", "profiles", "tools", "tests", "docs")
SPECIAL_SOURCE_NAMES = {"Dockerfile"}
EXCLUDED_PARTS = {"node_modules", "dist", "build", ".pipeline", ".runtime"}
MIN_HEADER_TEXT_LENGTH = 12
SOURCE_KIND_BY_SUFFIX = {
    ".py": "python",
    ".sh": "shell",
    ".mjs": "javascript",
    ".js": "javascript",
    ".ts": "javascript",
    ".jq": "hash-comment",
}


def git_candidate_paths() -> list[pathlib.Path]:
    """Return tracked and publishable untracked files without scanning ignored state."""
    git_bin = shutil.which("git")
    if git_bin is None:
        raise ValueError("git is required for source-documentation checks")
    completed = subprocess.run(  # nosec B603
        [git_bin, "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [
        ROOT / relative
        for relative in completed.stdout.decode().split("\0")
        if relative and (ROOT / relative).is_file()
    ]


def is_in_source_scope(path: pathlib.Path) -> bool:
    """Limit the gate to maintained source roots and omit generated/runtime trees."""
    relative = path.relative_to(ROOT)
    if not relative.parts or relative.parts[0] not in SOURCE_ROOTS:
        return False
    return not any(part in EXCLUDED_PARTS for part in relative.parts)


def shebang_kind(text: str) -> str | None:
    """Recognize extensionless Python and Bash entrypoints from their interpreter."""
    if not text.startswith("#!"):
        return None
    first_line = text.splitlines()[0]
    if "python" in first_line:
        return "python"
    if "bash" in first_line:
        return "shell"
    return None


def source_kind(path: pathlib.Path, text: str) -> str | None:
    """Classify executable source formats where comments have stable syntax."""
    if not is_in_source_scope(path):
        return None
    if path.name in SPECIAL_SOURCE_NAMES:
        return "hash-comment"
    return SOURCE_KIND_BY_SUFFIX.get(path.suffix) or shebang_kind(text)


def first_relevant_line(text: str, *, skip_shellcheck: bool = False) -> str:
    """Find the first semantic line after interpreter and tool-control directives."""
    lines = text.splitlines()
    index = 1 if lines and lines[0].startswith("#!") else 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped:
            index += 1
            continue
        if skip_shellcheck and stripped.startswith("# shellcheck"):
            index += 1
            continue
        return stripped
    return ""


def has_source_header(path: pathlib.Path, text: str) -> bool:
    """Check the language-appropriate file header without judging prose style."""
    kind = source_kind(path, text)
    if kind is None:
        return True
    if kind == "python":
        try:
            return ast.get_docstring(ast.parse(text)) is not None
        except SyntaxError:
            return False
    if kind == "shell":
        line = first_relevant_line(text, skip_shellcheck=True)
        return line.startswith("#") and len(line.lstrip("#").strip()) >= MIN_HEADER_TEXT_LENGTH
    if kind == "javascript":
        line = first_relevant_line(text)
        return line.startswith(("/**", "/*", "//"))
    line = first_relevant_line(text)
    return line.startswith("#") and len(line.lstrip("#").strip()) >= MIN_HEADER_TEXT_LENGTH


def missing_source_headers(paths: list[pathlib.Path] | None = None) -> list[str]:
    """List source files whose top-level purpose is not documented."""
    candidates = paths if paths is not None else git_candidate_paths()
    missing: list[str] = []
    for path in candidates:
        if (
            path.suffix
            and path.suffix not in SOURCE_KIND_BY_SUFFIX
            and path.name not in SPECIAL_SOURCE_NAMES
        ):
            continue
        text = path.read_text(encoding="utf-8")
        if source_kind(path, text) is not None and not has_source_header(path, text):
            missing.append(path.relative_to(ROOT).as_posix())
    return sorted(missing)


def main() -> int:
    """Report all missing headers together so one pass can repair the full corpus."""
    missing = missing_source_headers()
    if missing:
        print("Missing source documentation headers:", file=sys.stderr)
        for relative in missing:
            print(f"- {relative}", file=sys.stderr)
        return 1
    print("PASS: source documentation headers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
