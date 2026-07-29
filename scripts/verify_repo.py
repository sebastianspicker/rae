#!/usr/bin/env python3
"""Repository-level checks for public hygiene, docs, eval metadata, and MkDocs.

Package-local regression suites live under their owning runtime. This script
only checks the umbrella surfaces that make repository claims visible and
publishable.
"""

import argparse
import fnmatch
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import zlib
from typing import Any

from defusedxml import ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
LOCAL_DOC_DIRECTORIES = {"agent", "archive"}
REQUIRED_FRONTMATTER = {"status", "owner", "last_reviewed", "source_of_truth"}
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
MIN_EXTERNAL_SOURCES = 7
MAX_CURATED_SVG_BYTES = 1_000_000
MAX_SOCIAL_PREVIEW_BYTES = 1_000_000
SOCIAL_PREVIEW_DIMENSIONS = (1280, 640)
SOURCE_LINK_RE = re.compile(r"bibliography\.md#src-[A-Za-z0-9._-]+")
SVG_URL_START_RE = re.compile(r"url\s*\(", re.IGNORECASE)
SVG_URL_RE = re.compile(r"url\s*\(([^)]*)\)", re.IGNORECASE)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PUBLIC_ROOT_MARKDOWN = (
    "README.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "RELEASING.md",
    "RELEASE_NOTES.md",
    "RELEASE_STATUS.md",
    "SECURITY.md",
    "SUPPORT.md",
)
REQUIRED_PUBLIC_FILES = (
    *PUBLIC_ROOT_MARKDOWN,
    "CITATION.cff",
    "LICENSE",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/documentation.yml",
    ".github/ISSUE_TEMPLATE/feature-request.yml",
    ".github/release.yml",
    "docs/assets/screenshots/rae-agent-safety.svg",
    "docs/assets/screenshots/rae-cli.svg",
    "docs/assets/brand/rae-mark.svg",
    "docs/assets/brand/rae-lockup-light.svg",
    "docs/assets/brand/rae-lockup-dark.svg",
    "docs/assets/brand/rae-social-preview.svg",
    "docs/assets/brand/rae-social-preview.png",
    "docs/stylesheets/brand.css",
)
REQUIRED_REPOSITORY_FILES = (
    *REQUIRED_PUBLIC_FILES,
    "mkdocs.yml",
    "requirements-ci.txt",
    "requirements-macos.txt",
    "scripts/verify.sh",
    "scripts/verify_repo.py",
    "scripts/check_source_documentation.py",
    "docs/INDEX.md",
    "docs/reference/claims/claims-ledger.md",
    "docs/research/benchmark-protocol.md",
    "evals/README.md",
    "profiles/agent-environments/README.md",
)
OBSOLETE_PUBLIC_DIRECTORIES = {
    pathlib.PurePosixPath("archive"),
    pathlib.PurePosixPath("docs/agent"),
    pathlib.PurePosixPath("docs/archive"),
}
OBSOLETE_ROOT_PATTERNS = ("*AUDIT*.MD", "PLAN*.MD", "REMEDIATION*.MD", "STATUS*.MD")
CURATED_SCREENSHOTS = (
    "docs/assets/screenshots/rae-agent-safety.svg",
    "docs/assets/screenshots/rae-cli.svg",
)
BRAND_SVGS = (
    "docs/assets/brand/rae-mark.svg",
    "docs/assets/brand/rae-lockup-light.svg",
    "docs/assets/brand/rae-lockup-dark.svg",
    "docs/assets/brand/rae-social-preview.svg",
)
SOCIAL_PREVIEW = "docs/assets/brand/rae-social-preview.png"
FORBIDDEN_SVG_ELEMENTS = {"embed", "foreignobject", "iframe", "image", "object", "script"}


def path_within_root(path: pathlib.Path) -> bool:
    """Return True when an existing or future path stays under the repo root."""
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
    return sorted(
        path
        for path in DOCS.rglob("*.md")
        if path.relative_to(DOCS).parts[0] not in LOCAL_DOC_DIRECTORIES
    )


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
            raise ValueError(f"{path.relative_to(ROOT)} is missing frontmatter keys: {missing_str}")


def resolve_local_link(source: pathlib.Path, target: str) -> pathlib.Path | None:
    if not target or target.startswith(("http://", "https://", "mailto:", "#")):
        return None
    target_path = target.split("#", 1)[0].split("?", 1)[0]
    if not target_path:
        return None
    if target_path.startswith("/"):
        return ROOT / target_path.lstrip("/")
    return (source.parent / target_path).resolve()


def validate_link(source: pathlib.Path, target: str) -> None:
    resolved = resolve_local_link(source, target)
    if resolved is None:
        return
    if not path_within_root(resolved):
        raise ValueError(f"link escapes repository root in {source.relative_to(ROOT)} -> {target}")
    if not resolved.exists():
        raise ValueError(f"broken link in {source.relative_to(ROOT)} -> {target}")


def link_candidates() -> list[pathlib.Path]:
    candidates = [ROOT / relative for relative in PUBLIC_ROOT_MARKDOWN]
    candidates.extend(iter_markdown_files())
    return [path for path in candidates if path.exists()]


def validate_links() -> None:
    for path in link_candidates():
        text = path.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            validate_link(path, match.group(1).strip())


def validate_doc_source_density() -> None:
    """Require claim-bearing docs to cite enough bibliography entries."""
    for path in iter_markdown_files():
        text = path.read_text(encoding="utf-8")
        count = len(set(SOURCE_LINK_RE.findall(text)))
        if count < MIN_EXTERNAL_SOURCES:
            raise ValueError(
                f"{path.relative_to(ROOT)} has {count} external sources; "
                f"minimum is {MIN_EXTERNAL_SOURCES}"
            )


def validate_required_files() -> None:
    required = [ROOT / relative for relative in REQUIRED_REPOSITORY_FILES]
    missing = [path.relative_to(ROOT).as_posix() for path in required if not path.exists()]
    if missing:
        raise ValueError(f"missing required files: {', '.join(missing)}")


def git_bytes(*args: str) -> bytes:
    """Run Git with verifier-owned arguments and return its raw output."""
    git_bin = shutil.which("git")
    if git_bin is None:
        raise ValueError("git is required for public-candidate hygiene checks")
    # Resolved local Git and verifier-owned arguments; never a shell command.
    # nosemgrep: dangerous-subprocess-use-audit
    completed = subprocess.run(  # nosec B603
        [git_bin, *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return completed.stdout


def iter_public_candidate_paths() -> list[pathlib.Path]:
    relatives = git_bytes("ls-files", "-co", "--exclude-standard", "-z").decode().split("\0")
    return sorted(
        ROOT / relative for relative in relatives if relative and (ROOT / relative).is_file()
    )


def validate_release_candidate_git_state(
    *,
    status_output: bytes | None = None,
    tracked_relatives: set[str] | None = None,
) -> None:
    status = status_output
    if status is None:
        status = git_bytes("status", "--porcelain=v1", "-z", "--untracked-files=all")
    dirty_records = [record for record in status.decode().split("\0") if record]
    if dirty_records:
        sample = ", ".join(record[3:] for record in dirty_records[:10])
        raise ValueError(f"release candidate Git worktree is not clean: {sample}")

    tracked = tracked_relatives
    if tracked is None:
        tracked = set(git_bytes("ls-files", "-z").decode().split("\0"))
    missing = sorted(set(REQUIRED_REPOSITORY_FILES) - tracked)
    if missing:
        raise ValueError(f"release-required files are not tracked: {', '.join(missing)}")


def is_in_obsolete_public_directory(relative: pathlib.PurePosixPath) -> bool:
    return any(
        relative == directory or directory in relative.parents
        for directory in OBSOLETE_PUBLIC_DIRECTORIES
    )


def is_obsolete_root_work_file(relative: pathlib.PurePosixPath) -> bool:
    if len(relative.parts) != 1:
        return False
    upper_name = relative.name.upper()
    return any(fnmatch.fnmatch(upper_name, pattern) for pattern in OBSOLETE_ROOT_PATTERNS)


def validate_no_obsolete_public_artifacts(paths: list[pathlib.Path] | None = None) -> None:
    candidates = paths if paths is not None else iter_public_candidate_paths()
    obsolete: list[str] = []
    for path in candidates:
        relative = pathlib.PurePosixPath(path.relative_to(ROOT).as_posix())
        if is_in_obsolete_public_directory(relative) or is_obsolete_root_work_file(relative):
            obsolete.append(relative.as_posix())
    if obsolete:
        raise ValueError(f"obsolete public artifacts remain: {', '.join(sorted(set(obsolete)))}")


def parse_svg_root(text: str, relative: str) -> Any:
    try:
        return ET.fromstring(text)
    except ET.ParseError as exc:
        raise ValueError(f"{relative} is not valid SVG XML: {exc}") from exc


def xml_local_name(name: str) -> str:
    """Return the local component of an XML tag or namespaced attribute."""
    return name.rsplit("}", 1)[-1].lower()


def contains_external_svg_style(value: str) -> bool:
    """Return whether a normalized SVG value references active external content."""
    matches = list(SVG_URL_RE.finditer(value))
    if len(matches) != len(SVG_URL_START_RE.findall(value)):
        return True
    targets = [match.group(1).strip().strip("\"'").strip() for match in matches]
    return (
        "@import" in value
        or "javascript:" in value
        or any(not target.startswith("#") for target in targets)
    )


def validate_svg_attribute(attribute: str, value: str, relative: str) -> None:
    """Reject one active or externally resolved SVG attribute."""
    name = xml_local_name(attribute)
    if name.startswith("on"):
        raise ValueError(f"{relative} contains an SVG event handler")
    if name in {"href", "src"} and value and not value.startswith("#"):
        raise ValueError(f"{relative} contains an external SVG reference")
    if contains_external_svg_style(value.strip().lower()):
        raise ValueError(f"{relative} contains an external SVG style reference")


def validate_svg_element(element: Any, relative: str) -> None:
    """Reject active content and external references from one SVG element."""
    if xml_local_name(element.tag) in FORBIDDEN_SVG_ELEMENTS:
        raise ValueError(f"{relative} contains active or embedded SVG content")
    if contains_external_svg_style((element.text or "").lower()):
        raise ValueError(f"{relative} contains an external SVG style reference")
    for attribute, value in element.attrib.items():
        validate_svg_attribute(attribute, value, relative)


def validate_safe_svg(text: str, relative: str) -> Any:
    """Parse a bounded SVG and reject active content or external resources."""
    upper_text = text.upper()
    if len(text) > MAX_CURATED_SVG_BYTES:
        raise ValueError(f"{relative} contains unsafe or unexpectedly large XML")
    if "<!DOCTYPE" in upper_text or "<!ENTITY" in upper_text:
        raise ValueError(f"{relative} contains unsafe or unexpectedly large XML")
    root = parse_svg_root(text, relative)
    if xml_local_name(root.tag) != "svg":
        raise ValueError(f"{relative} is not an SVG document")
    for element in root.iter():
        validate_svg_element(element, relative)
    return root


def validate_svg_text(text: str, relative: str) -> None:
    validate_safe_svg(text, relative)
    if "Deterministic terminal capture" not in text:
        raise ValueError(f"{relative} is not a generated RAE terminal capture")
    for marker in ("/Users/", "C:\\Users\\"):
        if marker in text:
            raise ValueError(f"{relative} contains a private workstation path")


def validate_brand_svg(text: str, relative: str) -> None:
    """Require portable geometry and accessible text for a public brand SVG."""
    root = validate_safe_svg(text, relative)
    child_names = {xml_local_name(element.tag) for element in root.iter()}
    if "title" not in child_names or "desc" not in child_names:
        raise ValueError(f"{relative} requires SVG title and description elements")
    if not root.attrib.get("viewBox"):
        raise ValueError(f"{relative} requires an SVG viewBox")


def parse_png_chunks(data: bytes, relative: str) -> list[tuple[bytes, bytes]]:
    """Parse bounded PNG chunks and verify each declared length and CRC."""
    chunks: list[tuple[bytes, bytes]] = []
    offset = len(PNG_SIGNATURE)
    while offset < len(data):
        if len(data) - offset < 12:
            raise ValueError(f"{relative} contains a truncated PNG chunk")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        payload_end = offset + 8 + length
        chunk_end = payload_end + 4
        if chunk_end > len(data):
            raise ValueError(f"{relative} contains a truncated PNG chunk")
        chunk_type = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : payload_end]
        expected_crc = struct.unpack(">I", data[payload_end:chunk_end])[0]
        actual_crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError(f"{relative} contains an invalid PNG chunk CRC")
        chunks.append((chunk_type, payload))
        offset = chunk_end
    return chunks


def validate_png_chunk_sequence(chunks: list[tuple[bytes, bytes]], relative: str) -> None:
    """Require one leading IHDR, image data, and one terminal IEND chunk."""
    validate_png_header_chunk(chunks, relative)
    validate_png_data_and_end_chunks(chunks, relative)


def validate_png_header_chunk(chunks: list[tuple[bytes, bytes]], relative: str) -> None:
    """Require one well-sized leading PNG header chunk."""
    if not chunks:
        raise ValueError(f"{relative} is missing a valid PNG IHDR chunk")
    if chunks[0][0] != b"IHDR" or len(chunks[0][1]) != 13:
        raise ValueError(f"{relative} is missing a valid PNG IHDR chunk")
    if any(chunk_type == b"IHDR" for chunk_type, _ in chunks[1:]):
        raise ValueError(f"{relative} contains duplicate PNG IHDR chunks")


def validate_png_data_and_end_chunks(chunks: list[tuple[bytes, bytes]], relative: str) -> None:
    """Require image data followed by the terminal zero-length chunk."""
    compressed = b"".join(payload for chunk_type, payload in chunks if chunk_type == b"IDAT")
    if not compressed:
        raise ValueError(f"{relative} is missing PNG image data")
    try:
        if not zlib.decompress(compressed):
            raise ValueError(f"{relative} contains empty PNG image data")
    except zlib.error as exc:
        raise ValueError(f"{relative} contains invalid PNG image data") from exc
    if contains_nonterminal_png_end(chunks):
        raise ValueError(f"{relative} contains a non-terminal PNG IEND chunk")
    if chunks[-1] != (b"IEND", b""):
        raise ValueError(f"{relative} is missing a terminal PNG IEND chunk")


def contains_nonterminal_png_end(chunks: list[tuple[bytes, bytes]]) -> bool:
    """Return whether an IEND chunk appears before the final position."""
    return any(chunk_type == b"IEND" for chunk_type, _ in chunks[:-1])


def validate_social_preview_png(data: bytes, relative: str) -> None:
    """Validate GitHub's upload format and PNG chunk integrity."""
    if len(data) > MAX_SOCIAL_PREVIEW_BYTES:
        raise ValueError(f"{relative} must be smaller than 1 MB")
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"{relative} is not a valid PNG header")
    chunks = parse_png_chunks(data, relative)
    validate_png_chunk_sequence(chunks, relative)
    dimensions = struct.unpack(">II", chunks[0][1][:8])
    if dimensions != SOCIAL_PREVIEW_DIMENSIONS:
        expected = "x".join(str(value) for value in SOCIAL_PREVIEW_DIMENSIONS)
        actual = "x".join(str(value) for value in dimensions)
        raise ValueError(f"{relative} must be {expected}px, got {actual}px")


def validate_curated_screenshots() -> None:
    for relative in CURATED_SCREENSHOTS:
        path = ROOT / relative
        validate_svg_text(path.read_text(encoding="utf-8"), relative)
    # Fixed repository script under the current interpreter; never a shell command.
    # nosemgrep: dangerous-subprocess-use-audit
    subprocess.run(  # nosec B603
        [sys.executable, str(ROOT / "scripts/generate_docs_screenshots.py"), "--check"],
        cwd=ROOT,
        check=True,
    )


def validate_brand_assets() -> None:
    for relative in BRAND_SVGS:
        path = ROOT / relative
        validate_brand_svg(path.read_text(encoding="utf-8"), relative)
    validate_social_preview_png((ROOT / SOCIAL_PREVIEW).read_bytes(), SOCIAL_PREVIEW)


def validate_source_documentation() -> None:
    """Run the source-header contract as part of the public repository gate."""
    subprocess.run(  # nosec B603
        [sys.executable, str(ROOT / "scripts/check_source_documentation.py")],
        cwd=ROOT,
        check=True,
    )


def validate_eval_metadata() -> None:
    subprocess.run(  # nosec B603
        [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
        cwd=ROOT,
        check=True,
    )


def run_mkdocs_strict() -> None:
    mkdocs_bin = shutil.which("mkdocs")
    if mkdocs_bin is None:
        raise ValueError("mkdocs is required for the strict documentation build")
    mkdocs_env = os.environ.copy()
    mkdocs_env["NO_MKDOCS_2_WARNING"] = "true"
    subprocess.run(  # nosec B603
        [mkdocs_bin, "build", "--strict"],
        cwd=ROOT,
        check=True,
        env=mkdocs_env,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-mkdocs",
        action="store_true",
        help="skip the strict MkDocs build while retaining metadata and link checks",
    )
    parser.add_argument(
        "--release-candidate",
        action="store_true",
        help="require a clean Git worktree and tracked release-essential files",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.release_candidate and args.skip_mkdocs:
        raise ValueError("--release-candidate cannot be combined with --skip-mkdocs")
    validate_required_files()
    if args.release_candidate:
        validate_release_candidate_git_state()
    validate_no_obsolete_public_artifacts()
    validate_curated_screenshots()
    validate_brand_assets()
    validate_source_documentation()
    validate_frontmatter()
    validate_links()
    validate_doc_source_density()
    validate_eval_metadata()
    if not args.skip_mkdocs:
        run_mkdocs_strict()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - simple CLI path
        print(f"VERDICT: FAIL\n{exc}", file=sys.stderr)
        raise SystemExit(1) from None
