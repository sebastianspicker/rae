#!/usr/bin/env python3
"""Repository verification for the public scaffold."""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import os


ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
REQUIRED_FRONTMATTER = {"status", "owner", "last_reviewed", "source_of_truth"}
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
MIN_EXTERNAL_SOURCES = 7
SOURCE_LINK_RE = re.compile(r"bibliography\.md#src-[A-Za-z0-9._-]+")


def path_within_root(path: pathlib.Path) -> bool:
    resolved = path.resolve(strict=False)
    current = resolved if resolved.exists() else resolved.parent
    root = ROOT.resolve()
    while True:
        try:
            if current.samefile(root):
                return True
        except FileNotFoundError:
            pass
        if current == current.parent:
            return False
        current = current.parent


def iter_markdown_files() -> list[pathlib.Path]:
    return sorted(DOCS.rglob("*.md"))


def parse_frontmatter(path: pathlib.Path) -> set[str]:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        raise ValueError(f"{path.relative_to(ROOT)} is missing frontmatter start")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError(f"{path.relative_to(ROOT)} is missing frontmatter end")
    block = text[4:end].splitlines()
    keys: set[str] = set()
    for line in block:
        if ":" in line:
            key = line.split(":", 1)[0].strip()
            if key:
                keys.add(key)
    return keys


def validate_frontmatter() -> None:
    for path in iter_markdown_files():
        keys = parse_frontmatter(path)
        missing = REQUIRED_FRONTMATTER - keys
        if missing:
            missing_str = ", ".join(sorted(missing))
            raise ValueError(
                f"{path.relative_to(ROOT)} is missing frontmatter keys: {missing_str}"
            )


def validate_links() -> None:
    candidates = [ROOT / "README.md", ROOT / "CONTRIBUTING.md", ROOT / "SECURITY.md"]
    candidates.extend(iter_markdown_files())
    for path in candidates:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            target = match.group(1).strip()
            if not target or target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target_path = target.split("#", 1)[0].split("?", 1)[0]
            if not target_path:
                continue
            if target_path.startswith("/"):
                resolved = ROOT / target_path.lstrip("/")
            else:
                resolved = (path.parent / target_path).resolve()
            if not path_within_root(resolved):
                raise ValueError(
                    f"link escapes repository root in {path.relative_to(ROOT)} -> {target}"
                )
            if not resolved.exists():
                raise ValueError(f"broken link in {path.relative_to(ROOT)} -> {target}")


def validate_doc_source_density() -> None:
    for path in iter_markdown_files():
        text = path.read_text(encoding="utf-8")
        count = len(set(SOURCE_LINK_RE.findall(text)))
        if count < MIN_EXTERNAL_SOURCES:
            raise ValueError(
                f"{path.relative_to(ROOT)} has {count} external sources; "
                f"minimum is {MIN_EXTERNAL_SOURCES}"
            )


def validate_required_files() -> None:
    required = [
        ROOT / "README.md",
        ROOT / "mkdocs.yml",
        ROOT / "scripts/verify.sh",
        ROOT / "scripts/verify_repo.py",
        ROOT / "docs/INDEX.md",
        ROOT / "docs/reference/claims/claims-ledger.md",
        ROOT / "docs/research/benchmark-protocol.md",
        ROOT / "evals/README.md",
        ROOT / "profiles/agent-environments/README.md",
    ]
    missing = [
        path.relative_to(ROOT).as_posix() for path in required if not path.exists()
    ]
    if missing:
        raise ValueError(f"missing required files: {', '.join(missing)}")


def validate_eval_metadata() -> None:
    subprocess.run(
        [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
        cwd=ROOT,
        check=True,
    )


def run_mkdocs_strict() -> None:
    mkdocs_env = os.environ.copy()
    mkdocs_env["NO_MKDOCS_2_WARNING"] = "true"
    subprocess.run(
        ["mkdocs", "build", "--strict"], cwd=ROOT, check=True, env=mkdocs_env
    )


def main() -> int:
    validate_required_files()
    validate_frontmatter()
    validate_links()
    validate_doc_source_density()
    validate_eval_metadata()
    run_mkdocs_strict()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - simple CLI path
        print(f"VERDICT: FAIL\n{exc}", file=sys.stderr)
        raise SystemExit(1)
