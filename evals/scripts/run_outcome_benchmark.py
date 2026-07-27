#!/usr/bin/env python3
"""Run experimental autonomous-code-change tasks with a trusted judge registry.

Provider-backed execution is deliberately capped at three repeats and twelve
task attempts per invocation.  A bundle may hold up to eight tasks so that
separate split selections can share one reviewed fixture set.
"""

import argparse
import pathlib
import re
from typing import Any

from common import RESULTS_ROOT, ROOT, dump_json, is_within_directory, load_json
from lib.outcome_eval import (
    OUTCOME_REPORT_TYPE,
    aggregate_repeats,
    build_evaluator_manifest,
    evaluator_manifest_digest,
    run_rae_outcome_task,
    task_matrix_digest,
    validate_outcome_task,
)
from lib.policy_optimizer import policy_digest, validate_policy

MAX_OUTCOME_REPEATS = 3
MAX_OUTCOME_TASKS_PER_BUNDLE = 8
MAX_OUTCOME_TASK_ATTEMPTS = 12


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-bundle", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--split", required=True, choices=("dev", "held-out", "stress", "ablation"))
    parser.add_argument("--acknowledge-provider-usage", action="store_true")
    parser.add_argument("--repeats", type=int, default=1)
    return parser.parse_args()


def _repo_path(value: str, label: str) -> pathlib.Path:
    candidate = pathlib.Path(value)
    path = candidate.resolve() if candidate.is_absolute() else (ROOT / candidate).resolve()
    if not is_within_directory(path, ROOT):
        raise SystemExit(f"{label} must point under repository root")
    return path


def _validated_paths(
    args: argparse.Namespace,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    if not 1 <= args.repeats <= MAX_OUTCOME_REPEATS:
        raise SystemExit(f"repeats must be between 1 and {MAX_OUTCOME_REPEATS}")
    if not args.acknowledge_provider_usage:
        raise SystemExit("--acknowledge-provider-usage is required for autonomous outcome runs")
    bundle_path = _repo_path(args.task_bundle, "task-bundle")
    fixture_root = _repo_path(args.fixture_root, "fixture-root")
    output_dir = _repo_path(args.output_dir, "output-dir")
    policy_path = _repo_path(args.policy, "policy")
    if not is_within_directory(output_dir, RESULTS_ROOT):
        raise SystemExit("output-dir must point under evals/results")
    if output_dir.exists() and (not output_dir.is_dir() or any(output_dir.iterdir())):
        raise SystemExit("output-dir must be absent or empty")
    return bundle_path, fixture_root, output_dir, policy_path


def _load_bundle(bundle_path: pathlib.Path) -> dict[str, Any]:
    bundle = load_json(bundle_path)
    if not _valid_bundle_header(bundle):
        raise SystemExit("task-bundle does not match the experimental bundle contract")
    if len(bundle["tasks"]) > MAX_OUTCOME_TASKS_PER_BUNDLE:
        raise SystemExit(f"task-bundle exceeds the maximum of {MAX_OUTCOME_TASKS_PER_BUNDLE} tasks")
    return bundle


def _valid_bundle_header(bundle: object) -> bool:
    if not isinstance(bundle, dict) or set(bundle) != {"benchmark_id", "status", "tasks"}:
        return False
    if not isinstance(bundle.get("benchmark_id"), str):
        return False
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", bundle["benchmark_id"]):
        return False
    return bundle.get("status") == "experimental" and isinstance(bundle.get("tasks"), list) and bool(
        bundle["tasks"]
    )


def _selected_tasks(
    bundle: dict[str, Any], fixture_root: pathlib.Path, split: str
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    task_ids: set[str] = set()
    for task in bundle["tasks"]:
        try:
            validate_outcome_task(task)
        except ValueError as exc:
            raise SystemExit(f"invalid outcome task: {exc}") from exc
        if task["task_id"] in task_ids:
            raise SystemExit(f"duplicate outcome task_id: {task['task_id']}")
        task_ids.add(task["task_id"])
        fixture = fixture_root / task["fixture_id"]
        if not fixture.is_dir():
            raise SystemExit(f"fixture directory not found: {task['fixture_id']}")
        if task["split"] == split:
            selected.append(task)
    if not selected:
        raise SystemExit(f"task-bundle has no tasks for split: {split}")
    return selected


def _validate_attempt_budget(repeats: int, selected: list[dict[str, Any]]) -> None:
    task_attempts = repeats * len(selected)
    if task_attempts > MAX_OUTCOME_TASK_ATTEMPTS:
        raise SystemExit(
            "outcome run exceeds the maximum of "
            f"{MAX_OUTCOME_TASK_ATTEMPTS} task attempts/provider calls"
        )


def _load_policy(policy_path: pathlib.Path) -> dict[str, Any]:
    policy = load_json(policy_path)
    if not isinstance(policy, dict):
        raise SystemExit("policy must be a JSON object")
    try:
        validate_policy(policy)
    except ValueError as exc:
        raise SystemExit(f"invalid autonomous policy: {exc}") from exc

    return policy


def _run_repeats(
    repeats: int,
    selected: list[dict[str, Any]],
    fixture_root: pathlib.Path,
    output_dir: pathlib.Path,
    policy_path: pathlib.Path,
) -> list[list[dict[str, Any]]]:
    return [
        [
            run_rae_outcome_task(
                task=task,
                fixture_root=fixture_root / task["fixture_id"],
                workspace=output_dir / "workspaces" / f"repeat-{repeat}" / task["task_id"],
                policy_path=policy_path,
            )
            for task in selected
        ]
        for repeat in range(repeats)
    ]


def _report(
    bundle: dict[str, Any],
    split: str,
    repeats: list[list[dict[str, Any]]],
    bundle_path: pathlib.Path,
    fixture_root: pathlib.Path,
    policy: dict[str, Any],
) -> dict[str, Any]:
    manifest = build_evaluator_manifest(
        bundle_path=bundle_path,
        tasks=bundle["tasks"],
        fixture_root=fixture_root,
    )
    manifest_digest = evaluator_manifest_digest(manifest)
    aggregate = aggregate_repeats(repeats)
    return {
        "evidence_type": OUTCOME_REPORT_TYPE,
        "benchmark_id": bundle.get("benchmark_id"),
        "split": split,
        "task_matrix_digest": task_matrix_digest(repeats, manifest_digest),
        "repeat_count": len(repeats),
        "task_attempt_count": aggregate["task_attempt_count"],
        "evaluator_manifest": manifest,
        "evaluator_manifest_digest": manifest_digest,
        "policy_id": policy["policy_id"],
        "policy_digest": policy_digest(policy),
        "aggregate": aggregate,
        "repeats": repeats,
    }


def main() -> int:
    args = _args()
    bundle_path, fixture_root, output_dir, policy_path = _validated_paths(args)
    bundle = _load_bundle(bundle_path)
    selected = _selected_tasks(bundle, fixture_root, args.split)
    _validate_attempt_budget(args.repeats, selected)
    policy = _load_policy(policy_path)
    repeats = _run_repeats(args.repeats, selected, fixture_root, output_dir, policy_path)
    report = _report(bundle, args.split, repeats, bundle_path, fixture_root, policy)
    dump_json(output_dir / "outcome-benchmark-report.json", report)
    print((output_dir / "outcome-benchmark-report.json").relative_to(ROOT).as_posix())
    return 0 if report["aggregate"]["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
