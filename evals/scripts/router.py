#!/usr/bin/env python3
"""Route umbrella task specs to the smallest adequate runtime and emit a run card."""

import argparse
import pathlib
from typing import Any

from common import (
    ROOT,
    default_system_metadata,
    dump_json,
    iso_timestamp,
    load_json,
    new_run_id,
    repo_relpath,
    today_iso,
)

ROUTER_VERSION = "router-rule-v1"
# Execution profiles are intentionally closed. A task may request a profile,
# but the profile must still match the runtime selected by the router.
EXECUTION_COMMANDS = {
    "orchestration-init": "./scripts/rae.sh workflow long-horizon init <workspace>",
    "orchestration-review-loop": "./scripts/rae.sh orchestrate record-review-state --run-id <run_id> --state explain|fix|ship --status <status>",
    "orchestration-observability": "./scripts/rae.sh orchestrate summarize-progress --run-id <run_id>",
    "ralph-bootstrap-check": "./scripts/rae.sh workflow repo-audit bootstrap <repo> && MODE=audit ./.claude/ralph-audit/ralph.sh --check",
    "coauthor-validate": "./scripts/rae.sh hygiene coauthor-cleaner --validate-only --no-push <url> <path>",
}
EXECUTION_PROFILE_RUNTIMES = {
    "orchestration-init": "orchestration",
    "orchestration-review-loop": "orchestration",
    "orchestration-observability": "orchestration",
    "ralph-bootstrap-check": "ralph",
    "coauthor-validate": "tool",
}


def _select_runtime(task: dict[str, Any]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if task.get("repo_hygiene_operation") or task.get("destructive_operation"):
        runtime = "tool"
        reasons.append("narrow repo hygiene or destructive maintenance should stay explicit")
    elif task.get("requires_explicit_gates") or task.get("horizon") == "multi-phase":
        runtime = "orchestration"
        reasons.append("multi-phase work with explicit gates belongs in orchestration")
    elif task.get("requires_story_plan") or task.get("family") in {
        "repo-audit",
        "scoped-fix",
        "docs-correction",
    }:
        runtime = "ralph"
        reasons.append("story-sized audit or scoped-fix work belongs in Ralph")
    else:
        runtime = "ralph"
        reasons.append("defaulting to the smaller deterministic loop")
    return runtime, reasons


def _select_execution_profile(task: dict[str, Any], runtime: str) -> str:
    if "execution_profile" not in task or task["execution_profile"] is None:
        return {
            "orchestration": "orchestration-init",
            "ralph": "ralph-bootstrap-check",
            "tool": "coauthor-validate",
        }[runtime]
    execution_profile = task["execution_profile"]
    if not isinstance(execution_profile, str) or not execution_profile:
        raise ValueError("execution_profile must be a non-empty string")
    if execution_profile not in EXECUTION_COMMANDS:
        valid = ", ".join(sorted(EXECUTION_COMMANDS))
        raise ValueError(f"unknown execution_profile: {execution_profile}. Valid profiles: {valid}")
    profile_runtime = EXECUTION_PROFILE_RUNTIMES[execution_profile]
    if profile_runtime != runtime:
        raise ValueError(
            f"execution_profile {execution_profile} is for runtime {profile_runtime}, "
            f"not routed runtime {runtime}"
        )
    return execution_profile


def route_task(task: dict[str, Any]) -> dict[str, Any]:
    """Choose the smallest runtime that satisfies the task's explicit signals."""
    runtime, reasons = _select_runtime(task)
    execution_profile = _select_execution_profile(task, runtime)
    profile_runtime = EXECUTION_PROFILE_RUNTIMES[execution_profile]
    return {
        "runtime": runtime,
        "execution_profile": execution_profile,
        "profile_runtime": profile_runtime,
        "reasons": reasons,
        "command_preview": EXECUTION_COMMANDS[execution_profile],
    }


def build_run_card(
    *,
    task: dict[str, Any],
    task_spec_path: pathlib.Path,
    output_path: pathlib.Path,
    routed: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    """Build a planned run card before execution creates evidence artifacts."""
    run_card = {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": task.get("benchmark_id", "ad-hoc-task-routing"),
        "benchmark_version": str(task.get("benchmark_version", "0.0.0")),
        "date": today_iso(),
        "split": task.get("split", "dev"),
        "system": default_system_metadata(routed["runtime"]),
        "judge_version": "programmatic-route-judge-v1",
        "command": routed["command_preview"],
        "result_path": repo_relpath(output_path),
        "status": "planned",
        "task_id": task["task_id"],
        "task_spec_path": repo_relpath(task_spec_path),
        "routed_runtime": routed["runtime"],
        "router": {
            "version": ROUTER_VERSION,
            "decided_at": iso_timestamp(),
            "reasons": routed["reasons"],
            "execution_profile": routed["execution_profile"],
        },
        "claim_links": task.get("claim_links", []),
        "checkpoint_paths": [],
        "trace_paths": [],
        "artifact_paths": [],
        "notes": task.get("notes", ""),
    }
    if task.get("workflow_verb"):
        run_card["workflow_verb"] = task["workflow_verb"]
    if task.get("delegation_contract"):
        run_card["delegation_contract"] = task["delegation_contract"]
    return run_card


def _resolve_cli_path(value: str) -> pathlib.Path:
    path = pathlib.Path(value)
    return (ROOT / path).resolve() if not path.is_absolute() else path.resolve()


def _find_task(tasks: list[object], task_id: str) -> dict[str, Any] | None:
    for item in tasks:
        if isinstance(item, dict) and item.get("task_id") == task_id:
            return item
    return None


def _select_task(task_data: dict[str, Any], task_id: str | None) -> dict[str, Any]:
    if "tasks" not in task_data:
        return task_data
    if not task_id:
        raise SystemExit("task bundle requires --task-id")
    tasks = task_data.get("tasks", [])
    if not isinstance(tasks, list):
        raise SystemExit("task bundle tasks must be an array")
    task = _find_task(tasks, task_id)
    if task is None:
        raise SystemExit(f"task_id not found in bundle: {task_id}")
    if "benchmark_id" in task_data:
        task.setdefault("benchmark_id", task_data["benchmark_id"])
    if "version" in task_data:
        task.setdefault("benchmark_version", task_data["version"])
    return task


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Route a task spec to the umbrella runtime and emit a run card."
    )
    parser.add_argument("--task-spec", required=True, help="Path to a task spec JSON file.")
    parser.add_argument(
        "--output", required=True, help="Output path for the planned run card JSON."
    )
    parser.add_argument(
        "--task-id", help="When --task-spec points to a bundle, select this task_id."
    )
    parser.add_argument("--run-id", help="Optional explicit run id.")
    args = parser.parse_args()

    task_spec_path = _resolve_cli_path(args.task_spec)
    task_data = load_json(task_spec_path)
    if not isinstance(task_data, dict):
        raise SystemExit("task spec must be a JSON object")
    task = _select_task(task_data, args.task_id)
    if "task_id" not in task:
        raise SystemExit("task spec must contain task_id")

    routed = route_task(task)
    output_path = _resolve_cli_path(args.output)
    run_id = args.run_id or new_run_id(task["task_id"])
    run_card = build_run_card(
        task=task,
        task_spec_path=task_spec_path,
        output_path=output_path,
        routed=routed,
        run_id=run_id,
    )
    dump_json(output_path, run_card)
    print(repo_relpath(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
