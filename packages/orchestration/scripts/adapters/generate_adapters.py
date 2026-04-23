#!/usr/bin/env python3

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path


TOKEN_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def resolve_repo_path(root: Path, raw: str, label: str) -> Path:
    candidate = Path(raw)
    if candidate.is_absolute():
        raise ValueError(f"{label} must be a repository-relative path, got absolute path: {raw}")
    resolved = (root / candidate).resolve(strict=False)
    root_resolved = root.resolve(strict=False)
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError(f"{label} escapes repository root: {raw}") from exc
    return resolved


def render_template(path: Path, values: dict[str, str]) -> str:
    text = read_text(path)
    for key, value in values.items():
        text = text.replace(f"{{{{{key}}}}}", value)

    unresolved = sorted({m.group(1) for m in TOKEN_RE.finditer(text)})
    if unresolved:
        names = ", ".join(unresolved)
        raise ValueError(f"{path}: unresolved template token(s): {names}")

    if not text.endswith("\n"):
        text += "\n"
    return text


def compare_or_write(
    path: Path, content: str, check_only: bool, diffs: list[str], *, optional: bool = False
) -> None:
    current = read_text(path) if path.exists() else None
    if check_only:
        if optional and current is None:
            return
        if current != content:
            old = current.splitlines() if current is not None else []
            new = content.splitlines()
            diff = "\n".join(
                difflib.unified_diff(old, new, fromfile=f"{path} (current)", tofile=f"{path} (expected)", n=2)
            )
            diffs.append(diff)
        return

    if current == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def resolve_runner_titles(manifest: dict) -> dict[str, str]:
    runners = manifest.get("runners", [])
    titles: dict[str, str] = {}
    for item in runners:
        name = item.get("name")
        if not name:
            continue
        title = item.get("title") or name.capitalize()
        titles[name] = title
    return titles


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate adapter files from templates and validate sync with committed outputs."
    )
    parser.add_argument("--check", action="store_true", help="Check mode: do not write files, fail on drift.")
    parser.add_argument("--runner", action="append", help="Limit generation/check to one or more runner IDs.")
    parser.add_argument(
        "--manifest",
        default="adapters/spec/adapter-manifest.json",
        help="Adapter manifest path (default: adapters/spec/adapter-manifest.json).",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    manifest_path = root / args.manifest
    manifest = json.loads(read_text(manifest_path))

    generation = manifest.get("generation", {})
    template_root_rel = generation.get("template_root", "adapters/templates")
    template_root = resolve_repo_path(root, template_root_rel, "generation.template_root")
    if not template_root.exists():
        print(f"Template root not found: {template_root}", file=sys.stderr)
        return 2

    runners = manifest.get("runners", [])
    if not runners:
        print("Manifest has no runners.", file=sys.stderr)
        return 2

    available = {item.get("name") for item in runners if item.get("name")}
    requested = set(args.runner or available)
    unknown = sorted(requested - available)
    if unknown:
        print(f"Unknown runner(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    stage_order = manifest.get("stage_order", [])
    if not stage_order:
        print("Manifest missing stage_order.", file=sys.stderr)
        return 2

    runner_titles = resolve_runner_titles(manifest)
    legacy = generation.get("legacy_mirrors", {})
    cursor_mirror_root = legacy.get("cursor_skills_root")
    codex_playbook_target = legacy.get("codex_playbook")
    root_entries = legacy.get("root_entries", {})
    if not isinstance(root_entries, dict):
        raise ValueError("generation.legacy_mirrors.root_entries must be an object")

    diffs: list[str] = []
    writes = 0

    for runner in runners:
        runner_id = runner.get("name")
        if runner_id not in requested:
            continue

        stage_map = runner.get("stage_adapters", {})
        if not isinstance(stage_map, dict):
            raise ValueError(f"runner '{runner_id}' stage_adapters must be an object")
        runner_title = runner_titles.get(runner_id, runner_id.capitalize())
        adapter_root = runner.get("skills_root") or f"adapters/{runner_id}/skills"
        resolve_repo_path(root, adapter_root, f"runner '{runner_id}' skills_root")

        values = {
            "RUNNER_TITLE": runner_title,
            "ADAPTER_ROOT": adapter_root,
        }

        for stage in stage_order:
            target_rel = stage_map.get(stage)
            if not target_rel:
                raise ValueError(f"Runner '{runner_id}' has no adapter path for stage '{stage}'.")
            if not isinstance(target_rel, str):
                raise ValueError(f"Runner '{runner_id}' stage '{stage}' path must be a string.")
            stage_dir = Path(target_rel).parent.name
            tmpl = template_root / "skills" / stage_dir / "SKILL.md.tmpl"
            if not tmpl.exists():
                raise FileNotFoundError(f"Missing template for stage '{stage}': {tmpl}")

            rendered = render_template(tmpl, values)
            target_path = resolve_repo_path(root, target_rel, f"runner '{runner_id}' stage '{stage}'")
            before = target_path.read_text(encoding="utf-8") if target_path.exists() else None
            compare_or_write(target_path, rendered, args.check, diffs)
            if not args.check and before != rendered:
                writes += 1

            if runner_id == "cursor" and cursor_mirror_root:
                mirror_root = resolve_repo_path(root, cursor_mirror_root, "legacy_mirrors.cursor_skills_root")
                mirror = mirror_root / stage_dir / "SKILL.md"
                before = mirror.read_text(encoding="utf-8") if mirror.exists() else None
                compare_or_write(mirror, rendered, args.check, diffs, optional=True)
                if not args.check and before != rendered:
                    writes += 1

        pipeline_skill_rel = runner.get("pipeline_skill")
        if pipeline_skill_rel:
            if not isinstance(pipeline_skill_rel, str):
                raise ValueError(f"Runner '{runner_id}' pipeline_skill must be a string.")
            pipeline_tmpl = template_root / "skills" / "orchestration-pipeline" / "SKILL.md.tmpl"
            if not pipeline_tmpl.exists():
                raise FileNotFoundError(f"Missing pipeline skill template: {pipeline_tmpl}")
            rendered_pipeline = render_template(pipeline_tmpl, values)
            pipeline_path = resolve_repo_path(root, pipeline_skill_rel, f"runner '{runner_id}' pipeline_skill")
            before = pipeline_path.read_text(encoding="utf-8") if pipeline_path.exists() else None
            compare_or_write(pipeline_path, rendered_pipeline, args.check, diffs)
            if not args.check and before != rendered_pipeline:
                writes += 1

        if runner_id == "codex" and codex_playbook_target:
            legacy_tmpl = template_root / "skills" / "orchestration" / "SKILL.md.tmpl"
            rendered_legacy = render_template(legacy_tmpl, values)
            legacy_path = resolve_repo_path(root, codex_playbook_target, "legacy_mirrors.codex_playbook")
            before = legacy_path.read_text(encoding="utf-8") if legacy_path.exists() else None
            compare_or_write(legacy_path, rendered_legacy, args.check, diffs, optional=True)
            if not args.check and before != rendered_legacy:
                writes += 1

        root_entry_path = root_entries.get(runner_id)
        if root_entry_path:
            if not isinstance(root_entry_path, str):
                raise ValueError(f"legacy root entry for '{runner_id}' must be a string path")
            root_tmpl = template_root / "root" / f"{runner_id.upper()}.md.tmpl"
            if not root_tmpl.exists():
                raise FileNotFoundError(f"Missing root entry template: {root_tmpl}")
            rendered_root = render_template(root_tmpl, values)
            target = resolve_repo_path(root, root_entry_path, f"legacy root entry for '{runner_id}'")
            before = target.read_text(encoding="utf-8") if target.exists() else None
            compare_or_write(target, rendered_root, args.check, diffs, optional=True)
            if not args.check and before != rendered_root:
                writes += 1

    if args.check:
        if diffs:
            print("FAIL: adapter sync check failed. Regenerate with:", file=sys.stderr)
            print("  python3 scripts/adapters/generate_adapters.py", file=sys.stderr)
            for idx, diff in enumerate(diffs, start=1):
                print(f"\n--- mismatch {idx} ---", file=sys.stderr)
                print(diff, file=sys.stderr)
            return 1
        print("OK: adapter templates and generated files are in sync")
        return 0

    print(f"OK: generated adapter files ({writes} file(s) updated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
