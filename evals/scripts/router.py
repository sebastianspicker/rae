#!/usr/bin/env python3
"""Route umbrella task specs to the smallest adequate runtime and emit a run card."""

from __future__ import annotations

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


def route_task(task: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []

    if task.get("repo_hygiene_operation") or task.get("destructive_operation"):
        runtime = "tool"
        reasons.append(
            "narrow repo hygiene or destructive maintenance should stay explicit"
        )
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

    execution_profile = str(task.get("execution_profile") or "")
    if not execution_profile:
        execution_profile = {
            "orchestration": "orchestration-init",
            "ralph": "ralph-bootstrap-check",
            "tool": "coauthor-validate",
        }[runtime]

    command_preview = {
        "orchestration-init": "./scripts/rae.sh workflow long-horizon init <workspace>",
        "orchestration-arm": "./scripts/rae.sh orchestrate run-stage --run-id <run_id> --phase arm --taskset <taskset>",
        "orchestration-review-loop": "./scripts/rae.sh orchestrate record-review-state --run-id <run_id> --state explain|fix|ship --status <status>",
        "orchestration-observability": "./scripts/rae.sh orchestrate summarize-progress --run-id <run_id>",
        "ralph-bootstrap-check": "./scripts/rae.sh workflow repo-audit bootstrap <repo> && MODE=audit ./.claude/ralph-audit/ralph.sh --check",
        "coauthor-validate": "./scripts/rae.sh hygiene coauthor-cleaner --validate-only --no-push <url> <path>",
        "route-only": "./scripts/rae.sh task route --task-spec <task-spec>",
    }.get(execution_profile, "./scripts/rae.sh help")

    return {
        "runtime": runtime,
        "execution_profile": execution_profile,
        "reasons": reasons,
        "command_preview": command_preview,
    }


def build_run_card(
    *,
    task: dict[str, Any],
    task_spec_path: pathlib.Path,
    output_path: pathlib.Path,
    routed: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Route a task spec to the umbrella runtime and emit a run card."
    )
    parser.add_argument(
        "--task-spec", required=True, help="Path to a task spec JSON file."
    )
    parser.add_argument(
        "--output", required=True, help="Output path for the planned run card JSON."
    )
    parser.add_argument(
        "--task-id", help="When --task-spec points to a bundle, select this task_id."
    )
    parser.add_argument("--run-id", help="Optional explicit run id.")
    args = parser.parse_args()

    task_spec_path = (
        (ROOT / args.task_spec).resolve()
        if not pathlib.Path(args.task_spec).is_absolute()
        else pathlib.Path(args.task_spec).resolve()
    )
    task_data = load_json(task_spec_path)
    if not isinstance(task_data, dict):
        raise SystemExit("task spec must be a JSON object")
    if "tasks" in task_data:
        if not args.task_id:
            raise SystemExit("task bundle requires --task-id")
        tasks = task_data.get("tasks", [])
        task = next(
            (item for item in tasks if item.get("task_id") == args.task_id), None
        )
        if task is None:
            raise SystemExit(f"task_id not found in bundle: {args.task_id}")
        if "benchmark_id" in task_data:
            task.setdefault("benchmark_id", task_data["benchmark_id"])
        if "version" in task_data:
            task.setdefault("benchmark_version", task_data["version"])
    else:
        task = task_data
    if "task_id" not in task:
        raise SystemExit("task spec must contain task_id")

    routed = route_task(task)
    output_path = (
        (ROOT / args.output).resolve()
        if not pathlib.Path(args.output).is_absolute()
        else pathlib.Path(args.output).resolve()
    )
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
