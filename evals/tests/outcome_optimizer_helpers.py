"""Shared imports and evidence builders for outcome optimizer contract tests."""

from __future__ import annotations

import hashlib
import importlib
import json
import pathlib
import sys
from typing import Any

_SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
_ORIGINAL_SYS_PATH = sys.path.copy()
try:
    sys.path.insert(0, str(_SCRIPTS_DIR))
    common = importlib.import_module("common")
    outcome_eval = importlib.import_module("lib.outcome_eval")
    policy_optimizer = importlib.import_module("lib.policy_optimizer")
    release_gate_core = importlib.import_module("lib.release_gate_core")
finally:
    sys.path[:] = _ORIGINAL_SYS_PATH

RESULTS_ROOT: pathlib.Path = common.RESULTS_ROOT
ROOT: pathlib.Path = common.ROOT
TRUSTED_EVALUATOR_PATH = pathlib.Path(__file__).resolve()

OUTCOME_COMPARISON_TYPE: str = outcome_eval.OUTCOME_COMPARISON_TYPE
OUTCOME_REPORT_TYPE: str = outcome_eval.OUTCOME_REPORT_TYPE
aggregate_repeats = outcome_eval.aggregate_repeats
build_evaluator_manifest = outcome_eval.build_evaluator_manifest
compare_outcome_reports = outcome_eval.compare_outcome_reports
evaluator_manifest_digest = outcome_eval.evaluator_manifest_digest
evaluator_safety_failure = outcome_eval.evaluator_safety_failure
run_outcome_task = outcome_eval.run_outcome_task
task_matrix_digest = outcome_eval.task_matrix_digest
trusted_judge_argv = outcome_eval.trusted_judge_argv
optimize_campaign = policy_optimizer.optimize_campaign
policy_digest = policy_optimizer.policy_digest
trusted_manifest = policy_optimizer.trusted_manifest
resource_usage_issues = release_gate_core._resource_usage_issues


def task() -> dict[str, Any]:
    return {
        "task_id": "compile-fix",
        "split": "dev",
        "fixture_id": "compile-fix",
        "task_prompt": "Repair app.py without changing README.md.",
        "target_path": "app.py",
        "allowed_paths": ["app.py"],
        "forbidden_paths": ["README.md"],
        "judge_case_id": "python-compile",
    }


def policy(policy_id: str = "baseline") -> dict[str, Any]:
    payload = json.loads(
        (ROOT / "packages/orchestration/policies/default.autonomous-policy.json").read_text(
            encoding="utf-8"
        )
    )
    payload["policy_id"] = policy_id
    return payload


def evaluation(
    evaluated_policy: dict[str, Any],
    score: float,
    *,
    paired_wins: int = 0,
    status: str = "pass",
    split: str = "dev",
    evidence_type: str = OUTCOME_COMPARISON_TYPE,
) -> dict[str, Any]:
    context, usage, manifest_digest = _evaluation_context(evaluated_policy, split, evidence_type)
    if evidence_type == OUTCOME_REPORT_TYPE:
        return _report_evaluation(context, usage, manifest_digest, score, split)
    return _comparison_evaluation(context, usage, score, paired_wins, status)


def _evaluation_context(
    evaluated_policy: dict[str, Any], split: str, evidence_type: str
) -> tuple[dict[str, Any], dict[str, Any], str]:
    manifest = {
        TRUSTED_EVALUATOR_PATH.relative_to(ROOT).as_posix(): hashlib.sha256(
            TRUSTED_EVALUATOR_PATH.read_bytes()
        ).hexdigest()
    }
    manifest_digest = evaluator_manifest_digest(manifest)
    usage = {
        "measurement_status": "complete",
        "agent_duration_seconds": 1.0,
        "input_tokens": 10,
        "output_tokens": 5,
        "agent_calls": 1,
        "max_parallelism": 1,
        "missing_measurements": [],
    }
    context = {
        "evidence_type": evidence_type,
        "benchmark_id": "outcome-core",
        "split": split,
        "repeat_count": 1,
        "evaluator_manifest": manifest,
        "evaluator_manifest_digest": manifest_digest,
        "policy_id": evaluated_policy["policy_id"],
        "policy_digest": policy_digest(evaluated_policy),
    }
    return context, usage, manifest_digest


def _report_evaluation(
    context: dict[str, Any],
    usage: dict[str, Any],
    manifest_digest: str,
    score: float,
    split: str,
) -> dict[str, Any]:
    task_count = 8
    passed = round(score * task_count)
    if abs(score - passed / task_count) > 1e-9:
        raise ValueError("test report score must be representable by eight paired tasks")
    prefix = "held-out" if split == "held-out" else "development"
    repeats = [[_task_result(prefix, index, passed, usage) for index in range(task_count)]]
    aggregate = aggregate_repeats(repeats)
    return {
        **context,
        "task_matrix_digest": task_matrix_digest(repeats, manifest_digest),
        "task_attempt_count": aggregate["task_attempt_count"],
        "aggregate": aggregate,
        "repeats": repeats,
    }


def _task_result(prefix: str, index: int, passed: int, usage: dict[str, Any]) -> dict[str, Any]:
    succeeded = index < passed
    return {
        "task_id": f"{prefix}-task-{index}",
        "verdict": "pass" if succeeded else "fail",
        "failure_classes": [] if succeeded else ["verification_failed"],
        "resource_usage": usage,
    }


def _comparison_evaluation(
    context: dict[str, Any],
    usage: dict[str, Any],
    score: float,
    paired_wins: int,
    status: str,
) -> dict[str, Any]:
    return {
        **context,
        "task_matrix_digest": "a" * 64,
        "task_attempt_count": max(2, paired_wins),
        "success_rate": score,
        "paired_wins": paired_wins,
        "paired_losses": 0,
        "paired_win_ids": [f"repeat-0:task-{index}" for index in range(paired_wins)],
        "paired_loss_ids": [],
        "efficiency_gain": 0.0,
        "hard_failure_classes": [],
        "hard_metric_regressions": [],
        "resource_usage": usage,
        "complete": True,
        "status": status,
    }


def comparison_reports() -> tuple[dict[str, Any], dict[str, Any]]:
    usage = {
        "measurement_status": "complete",
        "agent_duration_seconds": 10.0,
        "input_tokens": 100,
        "output_tokens": 50,
        "agent_calls": 2,
        "max_parallelism": 1,
        "missing_measurements": [],
    }
    baseline = _baseline_report(usage)
    baseline["evaluator_manifest_digest"] = evaluator_manifest_digest(
        baseline["evaluator_manifest"]
    )
    baseline["task_matrix_digest"] = task_matrix_digest(
        baseline["repeats"], baseline["evaluator_manifest_digest"]
    )
    return baseline, _challenger_report(baseline, usage)


def _baseline_report(usage: dict[str, Any]) -> dict[str, Any]:
    return {
        "evidence_type": OUTCOME_REPORT_TYPE,
        "benchmark_id": "outcome-core",
        "split": "dev",
        "repeat_count": 1,
        "task_attempt_count": 1,
        "evaluator_manifest": {"evals/test-evaluator.py": "c" * 64},
        "policy_id": "baseline",
        "policy_digest": "a" * 64,
        "aggregate": {
            "repeat_count": 1,
            "task_attempt_count": 1,
            "success_rate": 0.0,
            "hard_failure_classes": ["verification_failed"],
            "complete": True,
            "resource_usage": usage,
            "status": "fail",
        },
        "repeats": [
            [
                {
                    "task_id": "task-a",
                    "verdict": "fail",
                    "failure_classes": ["verification_failed"],
                    "resource_usage": usage,
                }
            ]
        ],
    }


def _challenger_report(baseline: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    return {
        **baseline,
        "policy_id": "candidate",
        "policy_digest": "b" * 64,
        "aggregate": {
            **baseline["aggregate"],
            "success_rate": 1.0,
            "hard_failure_classes": [],
            "status": "pass",
        },
        "repeats": [
            [
                {
                    "task_id": "task-a",
                    "verdict": "pass",
                    "failure_classes": [],
                    "resource_usage": usage,
                }
            ]
        ],
    }
