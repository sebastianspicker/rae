#!/usr/bin/env python3

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from dataclasses import dataclass
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
) -> bool:
    current = read_text(path) if path.exists() else None
    if check_only:
        if optional and current is None:
            return False
        if current != content:
            old = current.splitlines() if current is not None else []
            new = content.splitlines()
            diff = "\n".join(
                difflib.unified_diff(
                    old, new, fromfile=f"{path} (current)", tofile=f"{path} (expected)", n=2
                )
            )
            diffs.append(diff)
        return False

    if optional and current is None:
        return False

    if current == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate adapter files from templates and validate sync with committed outputs."
        )
    )
    parser.add_argument(
        "--check", action="store_true", help="Check mode: do not write files, fail on drift."
    )
    parser.add_argument(
        "--runner", action="append", help="Limit generation/check to one or more runner IDs."
    )
    parser.add_argument(
        "--manifest",
        default="adapters/spec/adapter-manifest.json",
        help="Adapter manifest path (default: adapters/spec/adapter-manifest.json).",
    )
    return parser.parse_args()


def validate_manifest(
    root: Path, manifest: dict, requested_runners: list[str] | None
) -> tuple[Path, list[dict], set[str], list[str]] | None:
    generation = manifest.get("generation", {})
    template_root_rel = generation.get("template_root", "adapters/templates")
    template_root = resolve_repo_path(root, template_root_rel, "generation.template_root")
    if not template_root.exists():
        print(f"Template root not found: {template_root}", file=sys.stderr)
        return None

    runners = manifest.get("runners", [])
    if not runners:
        print("Manifest has no runners.", file=sys.stderr)
        return None

    available = {item.get("name") for item in runners if item.get("name")}
    requested = set(requested_runners or available)
    unknown = sorted(requested - available)
    if unknown:
        print(f"Unknown runner(s): {', '.join(unknown)}", file=sys.stderr)
        return None

    stage_order = manifest.get("stage_order", [])
    if not stage_order:
        print("Manifest missing stage_order.", file=sys.stderr)
        return None

    return template_root, runners, requested, stage_order


@dataclass
class GenerationContext:
    root: Path
    template_root: Path
    stage_order: list[str]
    runner_titles: dict[str, str]
    cursor_mirror_root: str | None
    codex_playbook_target: str | None
    root_entries: dict
    check_only: bool
    diffs: list[str]


def generate_stage_adapters(
    context: GenerationContext,
    runner_id: str,
    stage_map: dict,
    values: dict[str, str],
) -> int:
    writes = 0
    for stage in context.stage_order:
        target_rel = stage_map.get(stage)
        if not target_rel:
            raise ValueError(f"Runner '{runner_id}' has no adapter path for stage '{stage}'.")
        if not isinstance(target_rel, str):
            raise ValueError(f"Runner '{runner_id}' stage '{stage}' path must be a string.")
        stage_dir = Path(target_rel).parent.name
        tmpl = context.template_root / "skills" / stage_dir / "SKILL.md.tmpl"
        if not tmpl.exists():
            raise FileNotFoundError(f"Missing template for stage '{stage}': {tmpl}")

        rendered = render_template(tmpl, values)
        target_path = resolve_repo_path(
            context.root, target_rel, f"runner '{runner_id}' stage '{stage}'"
        )
        writes += compare_or_write(target_path, rendered, context.check_only, context.diffs)
        writes += write_cursor_mirror(context, runner_id, stage_dir, rendered)
    return writes


def write_cursor_mirror(
    context: GenerationContext,
    runner_id: str,
    stage_dir: str,
    rendered: str,
) -> int:
    if runner_id != "cursor" or not context.cursor_mirror_root:
        return 0
    mirror_root = resolve_repo_path(
        context.root, context.cursor_mirror_root, "legacy_mirrors.cursor_skills_root"
    )
    mirror = mirror_root / stage_dir / "SKILL.md"
    return compare_or_write(mirror, rendered, context.check_only, context.diffs, optional=True)


def generate_pipeline_skill(
    context: GenerationContext,
    runner_id: str,
    pipeline_skill_rel: object,
    values: dict[str, str],
) -> int:
    if not pipeline_skill_rel:
        return 0
    if not isinstance(pipeline_skill_rel, str):
        raise ValueError(f"Runner '{runner_id}' pipeline_skill must be a string.")
    pipeline_tmpl = context.template_root / "skills" / "orchestration-pipeline" / "SKILL.md.tmpl"
    if not pipeline_tmpl.exists():
        raise FileNotFoundError(f"Missing pipeline skill template: {pipeline_tmpl}")
    rendered_pipeline = render_template(pipeline_tmpl, values)
    pipeline_path = resolve_repo_path(
        context.root, pipeline_skill_rel, f"runner '{runner_id}' pipeline_skill"
    )
    return compare_or_write(pipeline_path, rendered_pipeline, context.check_only, context.diffs)


def generate_codex_playbook(
    context: GenerationContext,
    runner_id: str,
    values: dict[str, str],
) -> int:
    if runner_id != "codex" or not context.codex_playbook_target:
        return 0
    legacy_tmpl = context.template_root / "skills" / "orchestration" / "SKILL.md.tmpl"
    rendered_legacy = render_template(legacy_tmpl, values)
    legacy_path = resolve_repo_path(
        context.root, context.codex_playbook_target, "legacy_mirrors.codex_playbook"
    )
    return compare_or_write(
        legacy_path, rendered_legacy, context.check_only, context.diffs, optional=True
    )


def generate_root_entry(
    context: GenerationContext,
    runner_id: str,
    root_entry_path: object,
    values: dict[str, str],
) -> int:
    if not root_entry_path:
        return 0
    if not isinstance(root_entry_path, str):
        raise ValueError(f"legacy root entry for '{runner_id}' must be a string path")
    root_tmpl = context.template_root / "root" / f"{runner_id.upper()}.md.tmpl"
    if not root_tmpl.exists():
        raise FileNotFoundError(f"Missing root entry template: {root_tmpl}")
    rendered_root = render_template(root_tmpl, values)
    target = resolve_repo_path(
        context.root, root_entry_path, f"legacy root entry for '{runner_id}'"
    )
    return compare_or_write(target, rendered_root, context.check_only, context.diffs, optional=True)


def generate_runner(
    context: GenerationContext,
    runner: dict,
) -> int:
    runner_id = runner["name"]
    stage_map = runner.get("stage_adapters", {})
    if not isinstance(stage_map, dict):
        raise ValueError(f"runner '{runner_id}' stage_adapters must be an object")
    runner_title = context.runner_titles.get(runner_id, runner_id.capitalize())
    adapter_root = runner.get("skills_root") or f"adapters/{runner_id}/skills"
    resolve_repo_path(context.root, adapter_root, f"runner '{runner_id}' skills_root")

    values = {"RUNNER_TITLE": runner_title, "ADAPTER_ROOT": adapter_root}
    writes = generate_stage_adapters(context, runner_id, stage_map, values)
    writes += generate_pipeline_skill(
        context,
        runner_id,
        runner.get("pipeline_skill"),
        values,
    )
    writes += generate_codex_playbook(context, runner_id, values)
    writes += generate_root_entry(
        context,
        runner_id,
        context.root_entries.get(runner_id),
        values,
    )
    return writes


def report_result(check_only: bool, diffs: list[str], writes: int) -> int:
    if not check_only:
        print(f"OK: generated adapter files ({writes} file(s) updated)")
        return 0
    if not diffs:
        print("OK: adapter templates and generated files are in sync")
        return 0
    print("FAIL: adapter sync check failed. Regenerate with:", file=sys.stderr)
    print("  python3 scripts/adapters/generate_adapters.py", file=sys.stderr)
    for idx, diff in enumerate(diffs, start=1):
        print(f"\n--- mismatch {idx} ---", file=sys.stderr)
        print(diff, file=sys.stderr)
    return 1


def main() -> int:
    args = parse_args()

    root = Path(__file__).resolve().parents[2]
    manifest_path = root / args.manifest
    manifest = json.loads(read_text(manifest_path))

    validated = validate_manifest(root, manifest, args.runner)
    if validated is None:
        return 2
    template_root, runners, requested, stage_order = validated

    runner_titles = resolve_runner_titles(manifest)
    generation = manifest.get("generation", {})
    legacy = generation.get("legacy_mirrors", {})
    cursor_mirror_root = legacy.get("cursor_skills_root")
    codex_playbook_target = legacy.get("codex_playbook")
    root_entries = legacy.get("root_entries", {})
    if not isinstance(root_entries, dict):
        raise ValueError("generation.legacy_mirrors.root_entries must be an object")

    diffs: list[str] = []
    context = GenerationContext(
        root,
        template_root,
        stage_order,
        runner_titles,
        cursor_mirror_root,
        codex_playbook_target,
        root_entries,
        args.check,
        diffs,
    )
    writes = 0

    for runner in (item for item in runners if item.get("name") in requested):
        writes += generate_runner(context, runner)

    return report_result(args.check, diffs, writes)


if __name__ == "__main__":
    raise SystemExit(main())
