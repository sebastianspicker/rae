"""Evidence validation and acceptance policy for offline optimizer campaigns."""

from __future__ import annotations

import math
import re
from typing import Any, cast

from lib.outcome_eval import aggregate_repeats, evaluator_manifest_digest, task_matrix_digest
from lib.policy_optimizer_policy import (
    MAX_OUTCOME_REPEATS,
    MAX_TASK_ATTEMPTS,
    MAX_TASKS_PER_REPEAT,
    MIN_IMPROVEMENT,
    MIN_PAIRED_WINS,
    Policy,
    policy_digest,
)

_OUTCOME_REPORT_TYPE = "autonomous-outcome-report"
_OUTCOME_COMPARISON_TYPE = "autonomous-outcome-comparison"


def _hard_failure(evaluation: dict[str, Any]) -> bool:
    return (
        bool(evaluation.get("hard_failure_classes"))
        or bool(evaluation.get("hard_metric_regressions"))
        or not bool(evaluation.get("complete", True))
    )


def _score(evaluation: dict[str, Any]) -> float:
    score = evaluation.get("success_rate")
    if (
        not isinstance(score, (int, float))
        or isinstance(score, bool)
        or not math.isfinite(float(score))
        or not 0 <= float(score) <= 1
    ):
        raise ValueError("evaluation success_rate must be finite and between 0 and 1")
    return float(score)


def _validate_resource_usage(evaluation: dict[str, Any]) -> None:
    usage = evaluation.get("resource_usage")
    if not isinstance(usage, dict):
        raise ValueError("evaluation resource_usage must be an object")
    status = usage.get("measurement_status")
    if not _is_resource_status(status):
        raise ValueError("evaluation resource measurement_status is invalid")
    fields = (
        "agent_duration_seconds",
        "input_tokens",
        "output_tokens",
        "agent_calls",
        "max_parallelism",
    )
    for field in fields:
        value = usage.get(field)
        if value is not None and not _is_nonnegative_number(value):
            raise ValueError(f"evaluation resource_usage.{field} must be finite and nonnegative")
    if not _has_complete_measurements(status, usage, fields):
        raise ValueError("complete evaluation resource usage is missing measurements")


def _is_nonnegative_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and value >= 0
    )


def _is_resource_status(value: Any) -> bool:
    return value in {"complete", "partial", "unavailable", "incomplete"}


def _has_complete_measurements(status: Any, usage: dict[str, Any], fields: tuple[str, ...]) -> bool:
    return status != "complete" or all(_is_nonnegative_number(usage.get(field)) for field in fields)


def _validate_evaluator_manifest(evaluation: dict[str, Any]) -> dict[str, str]:
    manifest = evaluation.get("evaluator_manifest")
    if not isinstance(manifest, dict) or not manifest or not _is_valid_manifest(manifest):
        raise ValueError("evaluation evaluator_manifest is invalid")
    digest = evaluator_manifest_digest(manifest)
    if evaluation.get("evaluator_manifest_digest") != digest:
        raise ValueError("evaluation evaluator_manifest_digest is invalid")
    return manifest


def _is_valid_manifest(manifest: dict[Any, Any]) -> bool:
    return all(
        isinstance(path, str)
        and bool(path)
        and isinstance(digest, str)
        and bool(re.fullmatch(r"[a-f0-9]{64}", digest))
        for path, digest in manifest.items()
    )


def _validate_report_evidence(evaluation: dict[str, Any]) -> None:
    repeats = evaluation.get("repeats")
    aggregate = evaluation.get("aggregate")
    if not isinstance(repeats, list) or not repeats or not isinstance(aggregate, dict):
        raise ValueError("outcome report must contain repeats and aggregate evidence")
    if len(repeats) > MAX_OUTCOME_REPEATS or not _has_bounded_repeats(repeats):
        raise ValueError("outcome report exceeds the bounded repeat or task matrix")
    if aggregate != aggregate_repeats(repeats):
        raise ValueError("outcome report aggregate does not match its repeats")
    _validate_report_summary(evaluation, aggregate)
    expected_matrix = task_matrix_digest(repeats, evaluation["evaluator_manifest_digest"])
    if evaluation.get("task_matrix_digest") != expected_matrix:
        raise ValueError("outcome report task_matrix_digest does not match its evidence")


def _has_bounded_repeats(repeats: list[Any]) -> bool:
    return all(
        isinstance(repeat, list) and repeat and len(repeat) <= MAX_TASKS_PER_REPEAT
        for repeat in repeats
    )


def _validate_report_summary(evaluation: dict[str, Any], aggregate: dict[str, Any]) -> None:
    for field in (
        "repeat_count",
        "task_attempt_count",
        "success_rate",
        "hard_failure_classes",
        "complete",
        "resource_usage",
        "status",
    ):
        if evaluation.get(field) != aggregate.get(field):
            raise ValueError(f"outcome report top-level {field} does not match its aggregate")


def _validate_comparison_evidence(evaluation: dict[str, Any]) -> None:
    _validate_comparison_attempts(evaluation)
    _validate_comparison_pair_ids(evaluation)
    _validate_comparison_efficiency(evaluation)
    _validate_comparison_identity(evaluation)


def _validate_comparison_attempts(evaluation: dict[str, Any]) -> None:
    attempts = evaluation.get("task_attempt_count")
    if (
        not isinstance(attempts, int)
        or isinstance(attempts, bool)
        or not 1 <= attempts <= MAX_TASK_ATTEMPTS
    ):
        raise ValueError("comparison task_attempt_count must be between 1 and 12")


def _validate_comparison_pair_ids(evaluation: dict[str, Any]) -> None:
    win_ids = evaluation.get("paired_win_ids")
    loss_ids = evaluation.get("paired_loss_ids")
    if not _are_valid_pair_ids(win_ids, loss_ids):
        raise ValueError("comparison paired IDs are invalid")
    _validate_comparison_counts(
        evaluation,
        cast(list[str], win_ids),
        cast(list[str], loss_ids),
    )


def _are_valid_pair_ids(win_ids: Any, loss_ids: Any) -> bool:
    if not isinstance(win_ids, list) or not isinstance(loss_ids, list):
        return False
    all_ids = [*win_ids, *loss_ids]
    return (
        all(isinstance(pair_id, str) and pair_id for pair_id in all_ids)
        and len(win_ids) == len(set(win_ids))
        and len(loss_ids) == len(set(loss_ids))
        and not (set(win_ids) & set(loss_ids))
    )


def _validate_comparison_counts(
    evaluation: dict[str, Any], win_ids: list[str], loss_ids: list[str]
) -> None:
    wins = evaluation.get("paired_wins")
    losses = evaluation.get("paired_losses")
    attempts = evaluation["task_attempt_count"]
    if (
        not isinstance(wins, int)
        or isinstance(wins, bool)
        or not isinstance(losses, int)
        or isinstance(losses, bool)
        or wins != len(win_ids)
        or losses != len(loss_ids)
        or wins + losses > attempts
    ):
        raise ValueError("comparison paired counts do not match paired IDs or task attempts")


def _validate_comparison_efficiency(evaluation: dict[str, Any]) -> None:
    efficiency = evaluation.get("efficiency_gain")
    if (
        not isinstance(efficiency, (int, float))
        or isinstance(efficiency, bool)
        or not math.isfinite(float(efficiency))
    ):
        raise ValueError("comparison efficiency_gain must be finite")


def _validate_comparison_identity(evaluation: dict[str, Any]) -> None:
    baseline_id = evaluation.get("baseline_policy_id")
    if not isinstance(baseline_id, str) or not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", baseline_id):
        raise ValueError("comparison baseline_policy_id is invalid")
    for field in (
        "baseline_policy_digest",
        "baseline_report_digest",
        "challenger_report_digest",
    ):
        if not isinstance(evaluation.get(field), str) or not re.fullmatch(
            r"[a-f0-9]{64}", evaluation[field]
        ):
            raise ValueError(f"comparison {field} is invalid")


def _normalized_evaluation(evaluation: dict[str, Any]) -> dict[str, Any]:
    if evaluation.get("evidence_type") == _OUTCOME_REPORT_TYPE and isinstance(
        evaluation.get("aggregate"), dict
    ):
        return {**evaluation, **evaluation["aggregate"]}
    return evaluation


def _validate_evaluation_identity(policy: Policy, evaluation: dict[str, Any]) -> None:
    if evaluation.get("policy_id") != policy["policy_id"]:
        raise ValueError("evaluation policy_id does not match the evaluated policy")
    if evaluation.get("policy_digest") != policy_digest(policy):
        raise ValueError("evaluation policy_digest does not match the evaluated policy")


def _validate_evaluation_stage(
    evaluation: dict[str, Any], expected_split: str, allowed_evidence_types: frozenset[str]
) -> None:
    if evaluation.get("evidence_type") not in allowed_evidence_types:
        raise ValueError("evaluation evidence_type is not accepted for this campaign stage")
    benchmark_id = evaluation.get("benchmark_id")
    if not isinstance(benchmark_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", benchmark_id):
        raise ValueError("evaluation benchmark_id is invalid")
    if evaluation.get("split") != expected_split:
        raise ValueError(f"evaluation split must be {expected_split}")


def _validate_evaluation_metadata(evaluation: dict[str, Any]) -> None:
    matrix_digest = evaluation.get("task_matrix_digest")
    if not isinstance(matrix_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", matrix_digest):
        raise ValueError("evaluation task_matrix_digest is invalid")
    repeat_count = evaluation.get("repeat_count")
    if (
        not isinstance(repeat_count, int)
        or isinstance(repeat_count, bool)
        or not 1 <= repeat_count <= MAX_OUTCOME_REPEATS
    ):
        raise ValueError("evaluation repeat_count must be between 1 and 3")


def _validate_evaluation_summary(evaluation: dict[str, Any]) -> None:
    if not isinstance(evaluation.get("complete"), bool):
        raise ValueError("evaluation complete must be boolean")
    if evaluation.get("status") not in {"pass", "fail"}:
        raise ValueError("evaluation status must be pass or fail")
    for field in ("hard_failure_classes", "hard_metric_regressions"):
        value = evaluation.get(field, [])
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"evaluation {field} must be a string array")


def _validate_evaluation_evidence(evaluation: dict[str, Any]) -> None:
    _score(evaluation)
    _validate_resource_usage(evaluation)
    _validate_evaluator_manifest(evaluation)
    if evaluation["evidence_type"] == _OUTCOME_REPORT_TYPE:
        _validate_report_evidence(evaluation)
    else:
        _validate_comparison_evidence(evaluation)


def _verified_evaluation(
    policy: Policy,
    evaluation: dict[str, Any],
    *,
    expected_split: str = "dev",
    allowed_evidence_types: frozenset[str] = frozenset(
        {_OUTCOME_REPORT_TYPE, _OUTCOME_COMPARISON_TYPE}
    ),
) -> dict[str, Any]:
    if not isinstance(evaluation, dict):
        raise ValueError("evaluator must return a JSON object")
    normalized = _normalized_evaluation(evaluation)
    _validate_evaluation_identity(policy, normalized)
    _validate_evaluation_stage(normalized, expected_split, allowed_evidence_types)
    _validate_evaluation_metadata(normalized)
    _validate_evaluation_summary(normalized)
    _validate_evaluation_evidence(normalized)
    return normalized


def _verified_sealed_evaluation(
    policy: Policy,
    evaluation: dict[str, Any],
    development_evaluation: dict[str, Any],
) -> dict[str, Any]:
    sealed = _verified_evaluation(
        policy,
        evaluation,
        expected_split="held-out",
        allowed_evidence_types=frozenset({_OUTCOME_REPORT_TYPE}),
    )
    if sealed["benchmark_id"] != development_evaluation["benchmark_id"]:
        raise ValueError("sealed evaluation benchmark_id differs from development evidence")
    if sealed["evaluator_manifest"] != development_evaluation["evaluator_manifest"]:
        raise ValueError("sealed evaluation evaluator manifest differs from development evidence")
    if sealed["task_matrix_digest"] == development_evaluation["task_matrix_digest"]:
        raise ValueError("sealed evaluation must use a distinct held-out task matrix")
    return sealed


def _accept(incumbent: dict[str, Any], challenger: dict[str, Any]) -> tuple[bool, str]:
    if _hard_failure(challenger):
        return False, "challenger-hard-failure"
    if _hard_failure(incumbent):
        return True, "incumbent-hard-failure"
    incumbent_score, challenger_score = _score(incumbent), _score(challenger)
    if challenger_score < incumbent_score:
        return False, "outcome-regression"
    if not _has_minimum_paired_wins(challenger):
        return False, "insufficient-paired-wins"
    if challenger_score - incumbent_score >= MIN_IMPROVEMENT:
        return True, "accepted-outcome-improvement"
    if _is_efficiency_improvement(incumbent_score, challenger_score, challenger):
        return True, "accepted-efficiency-improvement"
    return False, "insufficient-outcome-or-efficiency-improvement"


def _has_minimum_paired_wins(evaluation: dict[str, Any]) -> bool:
    wins = evaluation.get("paired_wins", 0)
    return isinstance(wins, int) and wins >= MIN_PAIRED_WINS


def _is_efficiency_improvement(
    incumbent_score: float, challenger_score: float, challenger: dict[str, Any]
) -> bool:
    gain = challenger.get("efficiency_gain", 0.0)
    return (
        challenger_score == incumbent_score
        and isinstance(gain, (int, float))
        and gain >= MIN_IMPROVEMENT
    )


def _resource_delta(evaluation: dict[str, Any]) -> dict[str, float] | None:
    usage = evaluation.get("resource_usage")
    if not isinstance(usage, dict) or usage.get("measurement_status") != "complete":
        return None
    required = ("agent_duration_seconds", "input_tokens", "output_tokens", "agent_calls")
    if any(not isinstance(usage.get(field), (int, float)) for field in required):
        return None
    return {
        "agent_duration_seconds": float(usage["agent_duration_seconds"]),
        "total_tokens": float(usage["input_tokens"] + usage["output_tokens"]),
        "agent_calls": float(usage["agent_calls"]),
    }


def _budget_exceeded(
    spent: dict[str, float], evaluation: dict[str, Any], budget: dict[str, float] | None
) -> bool:
    if budget is None:
        return False
    delta = _resource_delta(evaluation)
    if delta is None:
        return True
    limits = {
        "agent_duration_seconds": budget.get("max_agent_duration_seconds"),
        "total_tokens": budget.get("max_total_tokens"),
        "agent_calls": budget.get("max_agent_calls"),
    }
    for key, value in delta.items():
        spent[key] = spent.get(key, 0.0) + value
        limit = limits[key]
        if limit is not None and spent[key] > float(limit):
            return True
    return False
