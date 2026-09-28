#!/usr/bin/env python3

"""Validate repository skill frontmatter, names, and content-size constraints."""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_SKILL_NAME_LENGTH = 64
MAX_SKILL_DESCRIPTION_LENGTH = 1024
MAX_SKILL_FILE_LINES = 500


@dataclass(frozen=True)
class SkillError:
    path: Path
    message: str


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def _frontmatter_end(lines: list[str]) -> int | None:
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return index
    return None


def _frontmatter_fields(frontmatter: str) -> tuple[str | None, str | None]:
    name = None
    description = None
    for raw in frontmatter.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if name is None and (match := re.match(r"^name:\s*(.+?)\s*$", line)):
            name = match.group(1).strip().strip('"').strip("'")
        elif description is None and (match := re.match(r"^description:\s*(.+?)\s*$", line)):
            description = match.group(1).strip().strip('"').strip("'")
    return name, description


def _parse_frontmatter(skill_md: Path) -> tuple[str | None, str | None, list[SkillError]]:
    text = _read_text(skill_md)
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, None, [SkillError(skill_md, "Missing YAML frontmatter (must start with ---).")]
    end_idx = _frontmatter_end(lines)
    if end_idx is None:
        return (
            None,
            None,
            [SkillError(skill_md, "Unterminated YAML frontmatter (missing closing ---).")],
        )

    name, description = _frontmatter_fields("\n".join(lines[1:end_idx]))
    errors: list[SkillError] = []
    if name is None:
        errors.append(SkillError(skill_md, "Frontmatter missing required field: name"))
    if description is None:
        errors.append(SkillError(skill_md, "Frontmatter missing required field: description"))
    return name, description, errors


def _name_errors(skill_md: Path, skill_dir: Path, name: str | None) -> list[SkillError]:
    if name is None:
        return []
    errors: list[SkillError] = []
    if len(name) > MAX_SKILL_NAME_LENGTH:
        errors.append(
            SkillError(
                skill_md,
                f"name too long ({len(name)} > {MAX_SKILL_NAME_LENGTH})",
            )
        )
    if not NAME_RE.match(name):
        errors.append(SkillError(skill_md, f"Invalid name: {name!r}"))
    if name != skill_dir.name:
        errors.append(
            SkillError(
                skill_md,
                f"name {name!r} does not match directory {skill_dir.name!r}",
            )
        )
    return errors


def _body_errors(skill_md: Path, description: str | None) -> list[SkillError]:
    errors: list[SkillError] = []
    if description is not None and not (1 <= len(description) <= MAX_SKILL_DESCRIPTION_LENGTH):
        errors.append(
            SkillError(
                skill_md,
                "description length out of range "
                f"({len(description)}; must be 1..{MAX_SKILL_DESCRIPTION_LENGTH})",
            )
        )
    body = _read_text(skill_md)
    line_count = body.count("\n") + 1
    if line_count > MAX_SKILL_FILE_LINES:
        errors.append(
            SkillError(
                skill_md,
                f"SKILL.md too long ({line_count} lines > {MAX_SKILL_FILE_LINES})",
            )
        )
    if deep_ref := re.search(r"\b(assets|references|scripts)/[^\s)]+/[^\s)]+", body):
        errors.append(SkillError(skill_md, f"Deep file reference found: {deep_ref.group(0)!r}"))
    return errors


def _validate_skill_dir(skill_dir: Path) -> list[SkillError]:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return [SkillError(skill_dir, "Missing SKILL.md")]

    name, description, fm_errors = _parse_frontmatter(skill_md)
    return fm_errors + _name_errors(skill_md, skill_dir, name) + _body_errors(skill_md, description)


def _iter_skill_dirs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted([p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")])


def _root_chunks(args: argparse.Namespace) -> list[str]:
    chunks: list[str] = []
    if args.manifest:
        manifest_path = Path(args.manifest)
        if not manifest_path.exists():
            print(f"Manifest not found: {manifest_path}", file=sys.stderr)
            raise SystemExit(2)
        manifest = json.loads(_read_text(manifest_path))
        for runner in manifest.get("runners", []):
            skills_root = runner.get("skills_root")
            if skills_root:
                chunks.append(skills_root)

    if args.roots:
        chunks.extend(args.roots.split(","))
    if args.root:
        chunks.extend(args.root)
    if not chunks:
        return [".codex/skills"]
    return chunks


def _unique_root_paths(chunks: list[str]) -> list[Path]:
    cleaned: list[Path] = []
    seen: set[str] = set()
    for item in chunks:
        value = item.strip()
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        cleaned.append(Path(value))
    return cleaned


def _parse_roots(args: argparse.Namespace) -> list[Path]:
    return _unique_root_paths(_root_chunks(args))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate skill roots against AgentSkills constraints."
    )
    parser.add_argument(
        "--roots",
        default="",
        help="Comma-separated skills roots. If omitted, defaults to .codex/skills.",
    )
    parser.add_argument(
        "--root",
        action="append",
        help="Add an additional skills root. Can be repeated.",
    )
    parser.add_argument(
        "--manifest",
        help="Optional adapter manifest path. If set, include all runner skills_root entries.",
    )
    return parser.parse_args()


def validate_roots(roots: list[Path]) -> tuple[list[SkillError], int, list[Path]]:
    all_errors: list[SkillError] = []
    total_skills = 0
    missing_roots: list[Path] = []
    for root in roots:
        skill_dirs = _iter_skill_dirs(root)
        if not skill_dirs:
            missing_roots.append(root)
            continue
        total_skills += len(skill_dirs)
        for skill_dir in skill_dirs:
            all_errors.extend(_validate_skill_dir(skill_dir))
    return all_errors, total_skills, missing_roots


def report_results(
    roots: list[Path],
    all_errors: list[SkillError],
    total_skills: int,
    missing_roots: list[Path],
) -> int:
    if missing_roots:
        for root in missing_roots:
            print(f"{root}: no skill directories found", file=sys.stderr)
        print(f"\nFAIL: {len(missing_roots)} root(s) missing or empty", file=sys.stderr)
        return 2

    if all_errors:
        for error in all_errors:
            print(f"{error.path}: {error.message}", file=sys.stderr)
        print(f"\nFAIL: {len(all_errors)} error(s)", file=sys.stderr)
        return 1

    print(f"OK: validated {total_skills} skill(s) across {len(roots)} root(s)")
    return 0


def main() -> int:
    roots = _parse_roots(parse_args())
    if not roots:
        print("No skill roots resolved from arguments.", file=sys.stderr)
        return 2
    return report_results(roots, *validate_roots(roots))


if __name__ == "__main__":
    raise SystemExit(main())
