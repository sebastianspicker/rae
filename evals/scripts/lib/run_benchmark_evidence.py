"""Evidence helpers for executable benchmark runs."""

import json
import os
import pathlib
import re
import shutil
import sys
from typing import Any

from common import (
    RESULTS_ROOT,
    ROOT,
    dump_json,
    load_json,
    repo_relpath,
    resolve_metadata_path,
    run_command,
)

ARTIFACT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def validate_artifact_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not ARTIFACT_ID_RE.fullmatch(value):
        raise ValueError(f"{label} must match ^[a-z0-9][a-z0-9-]*$")
    return value


def parse_run_id(stdout: str) -> str | None:
    match = re.search(r"run_id:\s+([a-z0-9-]+)", stdout)
    return match.group(1) if match else None


def create_task_workspace(output_dir: pathlib.Path, task_id: str) -> pathlib.Path:
    task_id = validate_artifact_id(task_id, "task_id")
    workspace = output_dir / "workspaces" / task_id
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def _combined_returncode(results: tuple[dict[str, Any], ...]) -> int:
    return 0 if all(result["returncode"] == 0 for result in results) else 1


def _combined_stream(results: tuple[dict[str, Any], ...], field: str) -> str:
    return "\n".join(result[field] for result in results if result[field])


def _combined_duration(results: tuple[dict[str, Any], ...]) -> float:
    return round(sum(float(result["duration_seconds"]) for result in results), 4)


def merge_command_results(*results: dict[str, Any]) -> dict[str, Any]:
    if not results:
        raise ValueError("at least one command result is required")
    return {
        "argv": ["composite"],
        "cwd": results[-1]["cwd"],
        "returncode": _combined_returncode(results),
        "stdout": _combined_stream(results, "stdout"),
        "stderr": _combined_stream(results, "stderr"),
        "duration_seconds": _combined_duration(results),
    }


def write_task_spec(output_dir: pathlib.Path, task: dict[str, Any]) -> pathlib.Path:
    validate_artifact_id(task["task_id"], "task_id")
    path = output_dir / "task-specs" / f"{task['task_id']}.json"
    dump_json(path, task)
    return path


def write_command_result(
    output_dir: pathlib.Path, task_id: str, command_result: dict[str, Any]
) -> pathlib.Path:
    task_id = validate_artifact_id(task_id, "task_id")
    path = output_dir / "command-results" / f"{task_id}.command-result.json"
    dump_json(path, command_result)
    return path


def load_optional_json_artifact(path_str: str) -> dict[str, Any] | None:
    try:
        path = resolve_metadata_path(path_str, label="artifact path", contained_by=RESULTS_ROOT)
    except ValueError:
        return None
    if path.suffix != ".json" or not path.exists():
        return None
    try:
        data = load_json(path)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _required_evidence_types(task: dict[str, Any]) -> list[str]:
    required = task.get("delegation_contract", {}).get("required_evidence", [])
    return sorted(
        {
            entry["type"]
            for entry in required
            if isinstance(entry, dict) and isinstance(entry.get("type"), str)
        }
    )


def _artifact_semantic_entries(task_id: str, path: str) -> tuple[list[dict[str, Any]], set[str]]:
    artifact = load_optional_json_artifact(path)
    if not artifact:
        return [], set()
    fields = (
        ("coverage_ledger", "coverage-ledger", "requirement coverage ledger"),
        ("qc_summary", "qc-summary", "quality coverage summary"),
    )
    entries: list[dict[str, Any]] = []
    types: set[str] = set()
    for field, evidence_type, description in fields:
        if field in artifact:
            entries.append(
                {
                    "task_id": task_id,
                    "type": evidence_type,
                    "path": path,
                    "description": description,
                }
            )
            types.add(evidence_type)
    if "open_risks" in artifact or "review_state" in artifact:
        entries.append(
            {
                "task_id": task_id,
                "type": "risk-summary",
                "path": path,
                "description": "residual risk or review summary",
            }
        )
        types.add("risk-summary")
    return entries, types


def _artifact_evidence(
    task_id: str, paths: list[str], command_result_path: str
) -> tuple[list[dict[str, Any]], set[str]]:
    provided: list[dict[str, Any]] = []
    types: set[str] = set()
    for path in sorted(set(paths)):
        if path != command_result_path:
            provided.append(
                {
                    "task_id": task_id,
                    "type": "artifact",
                    "path": path,
                    "description": "execution artifact",
                }
            )
            types.add("artifact")
        semantic_entries, semantic_types = _artifact_semantic_entries(task_id, path)
        provided.extend(semantic_entries)
        types.update(semantic_types)
    return provided, types


def _path_evidence(
    task_id: str, paths: list[str], evidence_type: str, description: str
) -> list[dict[str, Any]]:
    return [
        {
            "task_id": task_id,
            "type": evidence_type,
            "path": path,
            "description": description,
        }
        for path in sorted(set(paths))
    ]


def _evidence_status(required_types: list[str], missing_types: list[str]) -> str:
    if not required_types or not missing_types:
        return "complete"
    if len(missing_types) == len(required_types):
        return "missing"
    return "partial"


def build_task_verification_evidence(
    task: dict[str, Any],
    *,
    command_result_path: str,
    trace_paths: list[str],
    artifact_paths: list[str],
    checkpoint_paths: list[str],
) -> dict[str, Any]:
    """Map produced artifacts to the evidence types required by a task."""
    required_types = _required_evidence_types(task)
    task_id = task["task_id"]
    provided: list[dict[str, Any]] = [
        {
            "task_id": task_id,
            "type": "command-log",
            "path": command_result_path,
            "description": "command result transcript",
        }
    ]
    provided_types = {"command-log"}
    trace_entries = _path_evidence(task_id, trace_paths, "trace", "execution trace")
    if trace_entries:
        provided.extend(trace_entries)
        provided_types.add("trace")
    artifact_entries, artifact_types = _artifact_evidence(
        task_id, artifact_paths, command_result_path
    )
    provided.extend(artifact_entries)
    provided_types.update(artifact_types)
    checkpoint_entries = _path_evidence(
        task_id, checkpoint_paths, "checkpoint", "human checkpoint artifact"
    )
    if checkpoint_entries:
        provided.extend(checkpoint_entries)
        provided_types.add("checkpoint")

    missing_types = sorted(set(required_types) - provided_types)
    return {
        "required_types": required_types,
        "provided": provided,
        "summary": {
            "status": _evidence_status(required_types, missing_types),
            "provided_types": sorted(provided_types),
            "missing_types": missing_types,
            "residual_gaps": [
                f"missing evidence type: {evidence_type}" for evidence_type in missing_types
            ],
        },
    }


def aggregate_verification_evidence(
    task_results: list[dict[str, Any]],
) -> dict[str, Any]:
    """Summarize evidence completeness across all tasks in a benchmark split."""
    provided: list[dict[str, Any]] = []
    required_types: set[str] = set()
    provided_types: set[str] = set()
    missing_types: set[str] = set()
    residual_gaps: set[str] = set()
    task_statuses: list[dict[str, Any]] = []

    for result in task_results:
        evidence = result["verification_evidence"]
        required_types.update(evidence.get("required_types", []))
        provided.extend(evidence.get("provided", []))
        summary = evidence.get("summary", {})
        provided_types.update(summary.get("provided_types", []))
        missing_types.update(summary.get("missing_types", []))
        residual_gaps.update(summary.get("residual_gaps", []))
        task_statuses.append(
            {
                "task_id": result["task_id"],
                "status": summary.get("status", "missing"),
                "missing_types": summary.get("missing_types", []),
            }
        )

    task_status_values = {entry["status"] for entry in task_statuses}
    if not task_status_values or task_status_values == {"complete"}:
        status = "complete"
    elif task_status_values == {"missing"}:
        status = "missing"
    else:
        status = "partial"

    return {
        "required_types": sorted(required_types),
        "provided": provided,
        "task_statuses": task_statuses,
        "summary": {
            "status": status,
            "provided_types": sorted(provided_types),
            "missing_types": sorted(missing_types),
            "residual_gaps": sorted(residual_gaps),
        },
    }


def init_isolated_orchestration_workspace(
    workspace: pathlib.Path,
) -> tuple[pathlib.Path, dict[str, Any], str]:
    """Copy orchestration into a benchmark workspace while reusing dependencies."""
    source_root = ROOT / "packages/orchestration"
    package_root = workspace / "packages-orchestration"

    shutil.copytree(
        source_root,
        package_root,
        ignore=shutil.ignore_patterns(
            ".pipeline", ".worktrees", ".cache", "__pycache__", "*.pyc", "node_modules"
        ),
        symlinks=True,
    )

    ignored_dirs = {".pipeline", ".worktrees", ".cache", "__pycache__"}
    for current_root, dirnames, _ in os.walk(source_root):
        current_path = pathlib.Path(current_root)
        dirnames[:] = [name for name in dirnames if name not in ignored_dirs]
        if "node_modules" in dirnames:
            # The copied workspace must be isolated from generated pipeline state,
            # but reinstalling every workspace package per benchmark task would
            # make the deterministic eval path unnecessarily slow.
            src_node_modules = current_path / "node_modules"
            rel_path = src_node_modules.relative_to(source_root)
            dst_node_modules = package_root / rel_path
            dst_node_modules.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(src_node_modules, dst_node_modules, target_is_directory=True)
            dirnames.remove("node_modules")

    init_result = run_command(["bash", "./scripts/pipeline-init.sh", "."], cwd=package_root)
    if init_result["returncode"] != 0:
        raise RuntimeError(
            f"failed to initialize isolated orchestration pipeline: {init_result['stderr']}"
        )
    run_id = parse_run_id(init_result["stdout"])
    if run_id is None:
        raise RuntimeError("failed to parse isolated orchestration run_id")
    return package_root, init_result, run_id


def _checkpoint_create_command(
    checkpoint_path: pathlib.Path,
    run_id: str,
    task: dict[str, Any],
    config: dict[str, Any],
) -> list[str]:
    command = [
        sys.executable,
        str(ROOT / "evals/scripts/checkpoint.py"),
        "create",
        "--output",
        str(checkpoint_path),
        "--run-id",
        run_id,
        "--task-id",
        task["task_id"],
        "--gate-id",
        config.get("gate_id", "human-review"),
        "--title",
        config.get("title", f"Review {task['task_id']}"),
        "--required-for",
        config.get("required_for", "execution"),
        "--actor",
        "umbrella-eval-runner",
    ]
    for claim_link in task.get("claim_links", []):
        command.extend(["--claim-link", claim_link])
    return command


def _approve_checkpoint(
    checkpoint_path: pathlib.Path,
) -> tuple[bool, dict[str, Any]]:
    result = run_command(
        [
            sys.executable,
            str(ROOT / "evals/scripts/checkpoint.py"),
            "approve",
            "--checkpoint",
            str(checkpoint_path),
            "--actor",
            "umbrella-eval-runner",
            "--rationale",
            "auto-approved for deterministic local benchmark execution",
        ]
    )
    payload = load_optional_json_artifact(repo_relpath(checkpoint_path))
    approved = result["returncode"] == 0 and bool(payload and payload.get("status") == "approved")
    return approved, result


def create_checkpoint(
    output_dir: pathlib.Path, run_id: str, task: dict[str, Any], mode: str
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    config = task.get("human_checkpoint", {})
    if not config.get("required", False):
        return [], True, []
    checkpoint_path = output_dir / "checkpoints" / f"{task['task_id']}.checkpoint.json"
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    create_result = run_command(_checkpoint_create_command(checkpoint_path, run_id, task, config))
    checkpoint_results = [create_result]
    if create_result["returncode"] != 0 or not checkpoint_path.exists():
        return [], False, checkpoint_results

    approved = False
    if mode == "auto-approve":
        approved, approve_result = _approve_checkpoint(checkpoint_path)
        checkpoint_results.append(approve_result)
    return [repo_relpath(checkpoint_path)], approved, checkpoint_results
