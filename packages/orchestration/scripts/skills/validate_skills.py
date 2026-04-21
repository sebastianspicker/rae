#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@dataclass(frozen=True)
class SkillError:
    path: Path
    message: str


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def _parse_frontmatter(skill_md: Path) -> tuple[str | None, str | None, list[SkillError]]:
    text = _read_text(skill_md)
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, None, [SkillError(skill_md, "Missing YAML frontmatter (must start with ---).")]

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, None, [SkillError(skill_md, "Unterminated YAML frontmatter (missing closing ---).")]

    front = "\n".join(lines[1:end_idx])
    name = None
    description = None

    for raw in front.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if name is None:
            m = re.match(r"^name:\s*(.+?)\s*$", line)
            if m:
                name = m.group(1).strip().strip('"').strip("'")
                continue
        if description is None:
            m = re.match(r"^description:\s*(.+?)\s*$", line)
            if m:
                description = m.group(1).strip().strip('"').strip("'")
                continue

    errors: list[SkillError] = []
    if name is None:
        errors.append(SkillError(skill_md, "Frontmatter missing required field: name"))
    if description is None:
        errors.append(SkillError(skill_md, "Frontmatter missing required field: description"))
    return name, description, errors


def _validate_skill_dir(skill_dir: Path) -> list[SkillError]:
    errors: list[SkillError] = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        errors.append(SkillError(skill_dir, "Missing SKILL.md"))
        return errors

    name, description, fm_errors = _parse_frontmatter(skill_md)
    errors.extend(fm_errors)

    if name is not None:
        if len(name) > 64:
            errors.append(SkillError(skill_md, f"name too long ({len(name)} > 64)"))
        if not NAME_RE.match(name):
            errors.append(SkillError(skill_md, f"Invalid name: {name!r}"))
        if name != skill_dir.name:
            errors.append(SkillError(skill_md, f"name {name!r} does not match directory {skill_dir.name!r}"))

    if description is not None and not (1 <= len(description) <= 1024):
        errors.append(SkillError(skill_md, f"description length out of range ({len(description)}; must be 1..1024)"))

    body = _read_text(skill_md)
    line_count = body.count("\n") + 1
    if line_count > 500:
        errors.append(SkillError(skill_md, f"SKILL.md too long ({line_count} lines > 500)"))

    deep_ref = re.search(r"\b(assets|references|scripts)/[^\s)]+/[^\s)]+", body)
    if deep_ref:
        errors.append(SkillError(skill_md, f"Deep file reference found: {deep_ref.group(0)!r}"))

    return errors


def _iter_skill_dirs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted([p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")])


def _parse_roots(args: argparse.Namespace) -> list[Path]:
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
        chunks = [".codex/skills"]

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


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate skill roots against AgentSkills constraints.")
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
    args = parser.parse_args()

    roots = _parse_roots(args)
    if not roots:
        print("No skill roots resolved from arguments.", file=sys.stderr)
        return 2

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


if __name__ == "__main__":
    raise SystemExit(main())
