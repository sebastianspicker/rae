"""Evidence helpers for executable benchmark runs."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
from typing import Any

from common import (
    ROOT,
    dump_json,
    load_json,
    repo_relpath,
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


def merge_command_results(*results: dict[str, Any]) -> dict[str, Any]:
    if not results:
        raise ValueError("at least one command result is required")
    return {
        "argv": ["composite"],
        "cwd": results[-1]["cwd"],
        "returncode": 0 if all(result["returncode"] == 0 for result in results) else 1,
        "stdout": "\n".join(result["stdout"] for result in results if result["stdout"]),
        "stderr": "\n".join(result["stderr"] for result in results if result["stderr"]),
        "duration_seconds": round(
            sum(float(result["duration_seconds"]) for result in results), 4
        ),
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
    path = (ROOT / path_str).resolve(strict=False)
    if path.suffix != ".json" or not path.exists():
        return None
    try:
        data = load_json(path)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def build_task_verification_evidence(
    task: dict[str, Any],
    *,
    command_result_path: str,
    trace_paths: list[str],
    artifact_paths: list[str],
    checkpoint_paths: list[str],
) -> dict[str, Any]:
    """Map produced artifacts to the evidence types required by a task."""
    required_evidence = task.get("delegation_contract", {}).get("required_evidence", [])
    required_types = sorted(
        {
            entry["type"]
            for entry in required_evidence
            if isinstance(entry, dict) and isinstance(entry.get("type"), str)
        }
    )

    provided: list[dict[str, Any]] = [
        {
            "task_id": task["task_id"],
            "type": "command-log",
            "path": command_result_path,
            "description": "command result transcript",
        }
    ]
    provided_types = {"command-log"}

    for path in sorted(set(trace_paths)):
        provided.append(
            {
                "task_id": task["task_id"],
                "type": "trace",
                "path": path,
                "description": "execution trace",
            }
        )
        provided_types.add("trace")

    for path in sorted(set(artifact_paths)):
        if path != command_result_path:
            provided.append(
                {
                    "task_id": task["task_id"],
                    "type": "artifact",
                    "path": path,
                    "description": "execution artifact",
                }
            )
            provided_types.add("artifact")
        artifact = load_optional_json_artifact(path)
        if not artifact:
            continue
        if "coverage_ledger" in artifact:
            provided.append(
                {
                    "task_id": task["task_id"],
                    "type": "coverage-ledger",
                    "path": path,
                    "description": "requirement coverage ledger",
                }
            )
            provided_types.add("coverage-ledger")
        if "qc_summary" in artifact:
            provided.append(
                {
                    "task_id": task["task_id"],
                    "type": "qc-summary",
                    "path": path,
                    "description": "quality coverage summary",
                }
            )
            provided_types.add("qc-summary")
        if "open_risks" in artifact or "review_state" in artifact:
            provided.append(
                {
                    "task_id": task["task_id"],
                    "type": "risk-summary",
                    "path": path,
                    "description": "residual risk or review summary",
                }
            )
            provided_types.add("risk-summary")

    for path in sorted(set(checkpoint_paths)):
        provided.append(
            {
                "task_id": task["task_id"],
                "type": "checkpoint",
                "path": path,
                "description": "human checkpoint artifact",
            }
        )
        provided_types.add("checkpoint")

    missing_types = sorted(set(required_types) - provided_types)
    if not required_types or not missing_types:
        status = "complete"
    elif len(missing_types) == len(required_types):
        status = "missing"
    else:
        status = "partial"

    return {
        "required_types": required_types,
        "provided": provided,
        "summary": {
            "status": status,
            "provided_types": sorted(provided_types),
            "missing_types": missing_types,
            "residual_gaps": [
                f"missing evidence type: {evidence_type}"
                for evidence_type in missing_types
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

    init_result = run_command(
        ["bash", "./scripts/pipeline-init.sh", "."], cwd=package_root
    )
    if init_result["returncode"] != 0:
        raise RuntimeError(
            f"failed to initialize isolated orchestration pipeline: {init_result['stderr']}"
        )
    run_id = parse_run_id(init_result["stdout"])
    if run_id is None:
        raise RuntimeError("failed to parse isolated orchestration run_id")
    return package_root, init_result, run_id


def create_checkpoint(
    output_dir: pathlib.Path, run_id: str, task: dict[str, Any], mode: str
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    checkpoint_config = task.get("human_checkpoint", {})
    if not checkpoint_config.get("required", False):
        return [], True, []

    checkpoint_dir = output_dir / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = checkpoint_dir / f"{task['task_id']}.checkpoint.json"
    create_cmd = [
        "python3",
        str(ROOT / "evals/scripts/checkpoint.py"),
        "create",
        "--output",
        str(checkpoint_path),
        "--run-id",
        run_id,
        "--task-id",
        task["task_id"],
        "--gate-id",
        checkpoint_config.get("gate_id", "human-review"),
        "--title",
        checkpoint_config.get("title", f"Review {task['task_id']}"),
        "--required-for",
        checkpoint_config.get("required_for", "execution"),
        "--actor",
        "umbrella-eval-runner",
    ]
    for claim_link in task.get("claim_links", []):
        create_cmd.extend(["--claim-link", claim_link])
    create_result = run_command(create_cmd)
    checkpoint_results = [create_result]
    if create_result["returncode"] != 0 or not checkpoint_path.exists():
        return [], False, checkpoint_results

    approved = mode == "auto-approve"
    if approved:
        approve_result = run_command(
            [
                "python3",
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
        checkpoint_results.append(approve_result)
        if approve_result["returncode"] != 0:
            return [repo_relpath(checkpoint_path)], False, checkpoint_results
        checkpoint_ok = load_optional_json_artifact(repo_relpath(checkpoint_path))
        approved = bool(checkpoint_ok and checkpoint_ok.get("status") == "approved")
    return [repo_relpath(checkpoint_path)], approved, checkpoint_results
