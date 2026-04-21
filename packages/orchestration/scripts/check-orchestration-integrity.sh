#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for orchestration integrity checks." >&2
  exit 2
fi

if ! python3 - "$root_dir" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
root_real = root.resolve(strict=False)
manifest_path = root / "adapters/spec/adapter-manifest.json"
quality_gate_path = root / "contracts/quality-gate.schema.json"

failures: list[str] = []


def resolve_repo_path(raw: str, label: str) -> pathlib.Path | None:
    candidate = pathlib.Path(raw)
    if candidate.is_absolute():
        failures.append(f"{label}: path must be repository-relative, got absolute path '{raw}'")
        return None
    resolved = (root / candidate).resolve(strict=False)
    try:
        resolved.relative_to(root_real)
    except ValueError:
        failures.append(f"{label}: path escapes repository root: '{raw}'")
        return None
    return resolved

if not manifest_path.exists():
    failures.append(f"missing adapter manifest: {manifest_path.relative_to(root)}")
else:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    stage_order = manifest.get("stage_order", [])
    expected_gates = manifest.get("expected_gates", {})
    pmatch_tokens = manifest.get("pmatch", {}).get("required_tokens", [])
    runners = manifest.get("runners", [])
    core_playbook = manifest.get("core_playbook")

    if not stage_order:
        failures.append("adapter manifest missing stage_order")
    if not expected_gates:
        failures.append("adapter manifest missing expected_gates")
    if not runners:
        failures.append("adapter manifest missing runners")

    def assert_order(path: pathlib.Path, tokens: list[str], scope: str) -> None:
        if not path.exists():
            failures.append(f"{scope}: missing file {path.relative_to(root)}")
            return
        text = path.read_text(encoding="utf-8")
        idx = -1
        for token in tokens:
            pos = text.find(token, idx + 1)
            if pos == -1:
                failures.append(f"{scope}: missing stage token '{token}' in {path.relative_to(root)}")
                return
            if pos < idx:
                failures.append(f"{scope}: stage token '{token}' appears out of order in {path.relative_to(root)}")
                return
            idx = pos

    for runner in runners:
        name = runner.get("name", "<unknown>")
        stage_adapters = runner.get("stage_adapters", {})
        pipeline_skill = runner.get("pipeline_skill")

        if not isinstance(stage_adapters, dict):
            failures.append(f"runner '{name}' stage_adapters must be an object")
            continue

        missing_stages = sorted(set(stage_order) - set(stage_adapters.keys()))
        if missing_stages:
            failures.append(f"runner '{name}' missing stage mappings: {', '.join(missing_stages)}")

        extra_stages = sorted(set(stage_adapters.keys()) - set(stage_order))
        if extra_stages:
            failures.append(f"runner '{name}' has unknown stage mappings: {', '.join(extra_stages)}")

        for stage in stage_order:
            rel_path = stage_adapters.get(stage)
            if not rel_path:
                continue
            if not isinstance(rel_path, str):
                failures.append(f"runner '{name}' stage '{stage}' path must be a string")
                continue
            adapter_path = resolve_repo_path(rel_path, f"runner '{name}' stage '{stage}'")
            if adapter_path is None:
                continue
            if not adapter_path.exists():
                failures.append(f"runner '{name}' missing adapter for stage '{stage}': {rel_path}")
                continue

            gate_token = expected_gates.get(stage)
            if gate_token:
                text = adapter_path.read_text(encoding="utf-8")
                if gate_token not in text:
                    failures.append(
                        f"runner '{name}' adapter '{rel_path}' does not reference expected gate '{gate_token}'"
                    )

        pmatch_rel = stage_adapters.get("pmatch")
        if pmatch_rel:
            if not isinstance(pmatch_rel, str):
                failures.append(f"runner '{name}' pmatch path must be a string")
                pmatch_path = None
            else:
                pmatch_path = resolve_repo_path(pmatch_rel, f"runner '{name}' pmatch")
            if pmatch_path is None:
                continue
            if pmatch_path.exists():
                pmatch_text = pmatch_path.read_text(encoding="utf-8")
                for token in pmatch_tokens:
                    if token not in pmatch_text:
                        failures.append(f"runner '{name}' pmatch adapter missing required token '{token}'")

        if pipeline_skill:
            if not isinstance(pipeline_skill, str):
                failures.append(f"runner '{name}' pipeline_skill path must be a string")
            else:
                pipeline_path = resolve_repo_path(pipeline_skill, f"runner '{name}' pipeline")
                if pipeline_path is not None:
                    assert_order(pipeline_path, stage_order, f"runner '{name}' pipeline")
        else:
            failures.append(f"runner '{name}' missing pipeline_skill path")

    if core_playbook:
        if not isinstance(core_playbook, str):
            failures.append("core_playbook path must be a string")
        else:
            core_playbook_path = resolve_repo_path(core_playbook, "core playbook")
            # Skip if file does not exist (may be gitignored local-only)
            if core_playbook_path is not None and core_playbook_path.exists():
                assert_order(core_playbook_path, stage_order, "core playbook")

if not quality_gate_path.exists():
    failures.append(f"missing quality gate schema: {quality_gate_path.relative_to(root)}")
else:
    qg = json.loads(quality_gate_path.read_text(encoding="utf-8"))
    phase_enum = set(qg["properties"]["phase"]["enum"])
    expected_phases = {
        "arm",
        "design",
        "adversarial-review",
        "plan",
        "pmatch",
        "build",
        "quality-static",
        "quality-tests",
        "denoise",
        "quality-frontend",
        "quality-backend",
        "quality-docs",
        "security-review",
        "release-readiness",
    }
    missing_phases = sorted(expected_phases - phase_enum)
    if missing_phases:
        failures.append(f"quality gate schema phase enum missing: {', '.join(missing_phases)}")

if failures:
    print("FAIL: orchestration integrity check failed:", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    raise SystemExit(1)

print("OK: orchestration integrity checks passed")
PY
then
  exit 1
fi
