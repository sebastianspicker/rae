#!/usr/bin/env python3

"""Generate checked-in orchestration adapters from the runner manifest."""

import argparse
import difflib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

TOKEN_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def resolve_repo_path(root: Path, raw: str, label: str) -> Path:
    """Resolve a manifest path only when it remains contained by the repository root."""
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


def content_diff(path: Path, current: str | None, content: str) -> str:
    old = current.splitlines() if current is not None else []
    new = content.splitlines()
    return "\n".join(
        difflib.unified_diff(
            old,
            new,
            fromfile=f"{path} (current)",
            tofile=f"{path} (expected)",
            n=2,
        )
    )


def check_content(
    path: Path,
    current: str | None,
    content: str,
    diffs: list[str],
    optional: bool,
) -> None:
    if optional and current is None:
        return
    if current != content:
        diffs.append(content_diff(path, current, content))


def compare_or_write(
    path: Path, content: str, check_only: bool, diffs: list[str], *, optional: bool = False
) -> bool:
    current = read_text(path) if path.exists() else None
    if check_only:
        check_content(path, current, content, diffs, optional)
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


def load_manifest(root: Path, raw_path: str) -> dict:
    manifest_path = resolve_repo_path(root, raw_path, "manifest")
    manifest = json.loads(read_text(manifest_path))
    if not isinstance(manifest, dict):
        raise ValueError("adapter manifest must be a JSON object")
    return manifest


def require_mapping(value: object, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def resolve_requested_runners(runners: list[dict], requested_names: list[str] | None) -> set[str]:
    available = {name for item in runners if (name := item.get("name"))}
    requested = set(requested_names or available)
    unknown = sorted(requested - available)
    if unknown:
        raise ValueError(f"Unknown runner(s): {', '.join(unknown)}")
    return requested


@dataclass
class AdapterGenerator:
    root: Path
    template_root: Path
    check_only: bool
    cursor_mirror_root: object
    codex_playbook_target: object
    root_entries: dict
    runner_titles: dict[str, str]
    diffs: list[str] = field(default_factory=list)
    writes: int = 0

    def write(self, path: Path, content: str, *, optional: bool = False) -> None:
        if compare_or_write(path, content, self.check_only, self.diffs, optional=optional):
            self.writes += 1

    def generate_stages(
        self,
        runner_id: str,
        stage_map: dict,
        stage_order: list[str],
        values: dict[str, str],
    ) -> None:
        for stage in stage_order:
            target_rel = stage_map.get(stage)
            if not target_rel:
                raise ValueError(f"Runner '{runner_id}' has no adapter path for stage '{stage}'.")
            if not isinstance(target_rel, str):
                raise ValueError(f"Runner '{runner_id}' stage '{stage}' path must be a string.")
            stage_dir = Path(target_rel).parent.name
            template = self.template_root / "skills" / stage_dir / "SKILL.md.tmpl"
            if not template.exists():
                raise FileNotFoundError(f"Missing template for stage '{stage}': {template}")
            rendered = render_template(template, values)
            target = resolve_repo_path(
                self.root, target_rel, f"runner '{runner_id}' stage '{stage}'"
            )
            self.write(target, rendered)
            self.generate_cursor_mirror(runner_id, stage_dir, rendered)

    def generate_cursor_mirror(self, runner_id: str, stage_dir: str, rendered: str) -> None:
        if runner_id != "cursor" or not self.cursor_mirror_root:
            return
        if not isinstance(self.cursor_mirror_root, str):
            raise ValueError("legacy_mirrors.cursor_skills_root must be a string")
        mirror_root = resolve_repo_path(
            self.root,
            self.cursor_mirror_root,
            "legacy_mirrors.cursor_skills_root",
        )
        self.write(mirror_root / stage_dir / "SKILL.md", rendered, optional=True)

    def generate_pipeline_skill(self, runner_id: str, runner: dict, values: dict[str, str]) -> None:
        target_rel = runner.get("pipeline_skill")
        if not target_rel:
            return
        if not isinstance(target_rel, str):
            raise ValueError(f"Runner '{runner_id}' pipeline_skill must be a string.")
        template = self.template_root / "skills" / "orchestration-pipeline" / "SKILL.md.tmpl"
        if not template.exists():
            raise FileNotFoundError(f"Missing pipeline skill template: {template}")
        target = resolve_repo_path(self.root, target_rel, f"runner '{runner_id}' pipeline_skill")
        self.write(target, render_template(template, values))

    def generate_codex_playbook(self, runner_id: str, values: dict[str, str]) -> None:
        if runner_id != "codex" or not self.codex_playbook_target:
            return
        if not isinstance(self.codex_playbook_target, str):
            raise ValueError("legacy_mirrors.codex_playbook must be a string")
        template = self.template_root / "skills" / "orchestration" / "SKILL.md.tmpl"
        target = resolve_repo_path(
            self.root,
            self.codex_playbook_target,
            "legacy_mirrors.codex_playbook",
        )
        self.write(target, render_template(template, values), optional=True)

    def generate_root_entry(self, runner_id: str, values: dict[str, str]) -> None:
        target_rel = self.root_entries.get(runner_id)
        if not target_rel:
            return
        if not isinstance(target_rel, str):
            raise ValueError(f"legacy root entry for '{runner_id}' must be a string path")
        template = self.template_root / "root" / f"{runner_id.upper()}.md.tmpl"
        if not template.exists():
            raise FileNotFoundError(f"Missing root entry template: {template}")
        target = resolve_repo_path(self.root, target_rel, f"legacy root entry for '{runner_id}'")
        self.write(target, render_template(template, values), optional=True)

    def generate_runner(self, runner: dict, stage_order: list[str]) -> None:
        runner_id = runner.get("name")
        if not isinstance(runner_id, str) or not runner_id:
            raise ValueError("runner name must be a non-empty string")
        stage_map = require_mapping(
            runner.get("stage_adapters", {}),
            f"runner '{runner_id}' stage_adapters",
        )
        adapter_root = runner.get("skills_root") or f"adapters/{runner_id}/skills"
        if not isinstance(adapter_root, str):
            raise ValueError(f"runner '{runner_id}' skills_root must be a string")
        resolve_repo_path(self.root, adapter_root, f"runner '{runner_id}' skills_root")
        values = {
            "RUNNER_TITLE": self.runner_titles.get(runner_id, runner_id.capitalize()),
            "ADAPTER_ROOT": adapter_root,
        }
        self.generate_stages(runner_id, stage_map, stage_order, values)
        self.generate_pipeline_skill(runner_id, runner, values)
        self.generate_codex_playbook(runner_id, values)
        self.generate_root_entry(runner_id, values)

    def report(self) -> int:
        if not self.check_only:
            print(f"OK: generated adapter files ({self.writes} file(s) updated)")
            return 0
        if not self.diffs:
            print("OK: adapter templates and generated files are in sync")
            return 0
        print("FAIL: adapter sync check failed. Regenerate with:", file=sys.stderr)
        print("  python3 scripts/adapters/generate_adapters.py", file=sys.stderr)
        for index, diff in enumerate(self.diffs, start=1):
            print(f"\n--- mismatch {index} ---", file=sys.stderr)
            print(diff, file=sys.stderr)
        return 1


def build_generator(root: Path, manifest: dict, check_only: bool) -> AdapterGenerator:
    generation = manifest.get("generation", {})
    generation = require_mapping(generation, "generation")
    template_root_rel = generation.get("template_root", "adapters/templates")
    if not isinstance(template_root_rel, str):
        raise ValueError("generation.template_root must be a string")
    template_root = resolve_repo_path(root, template_root_rel, "generation.template_root")
    if not template_root.exists():
        raise FileNotFoundError(f"Template root not found: {template_root}")
    legacy = generation.get("legacy_mirrors", {})
    legacy = require_mapping(legacy, "generation.legacy_mirrors")
    cursor_mirror_root = legacy.get("cursor_skills_root")
    codex_playbook_target = legacy.get("codex_playbook")
    root_entries = require_mapping(
        legacy.get("root_entries", {}),
        "generation.legacy_mirrors.root_entries",
    )
    return AdapterGenerator(
        root=root,
        template_root=template_root,
        check_only=check_only,
        cursor_mirror_root=cursor_mirror_root,
        codex_playbook_target=codex_playbook_target,
        root_entries=root_entries,
        runner_titles=resolve_runner_titles(manifest),
    )


def generation_inputs(
    manifest: dict, requested_names: list[str] | None
) -> tuple[list[dict], set[str], list[str]]:
    runners = manifest.get("runners", [])
    if not isinstance(runners, list) or not runners:
        raise ValueError("Manifest has no runners.")
    runner_objects = [require_mapping(runner, "runner entry") for runner in runners]
    requested = resolve_requested_runners(runner_objects, requested_names)
    raw_stage_order = manifest.get("stage_order", [])
    if not isinstance(raw_stage_order, list) or not raw_stage_order:
        raise ValueError("Manifest missing stage_order.")
    if not all(isinstance(stage, str) for stage in raw_stage_order):
        raise ValueError("Manifest stage_order entries must be strings.")
    return runner_objects, requested, list(raw_stage_order)


def run_generation(root: Path, args: argparse.Namespace) -> int:
    manifest = load_manifest(root, args.manifest)
    runners, requested, stage_order = generation_inputs(manifest, args.runner)
    generator = build_generator(root, manifest, args.check)
    for runner in runners:
        if runner.get("name") in requested:
            generator.generate_runner(runner, stage_order)
    return generator.report()


def main() -> int:
    try:
        return run_generation(Path(__file__).resolve().parents[2], parse_args())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
