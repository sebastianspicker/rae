"""Paired autonomous-outcome comparison with independently verified evidence."""

from typing import Any, cast

from lib.outcome_eval import (
    OUTCOME_COMPARISON_TYPE,
    OUTCOME_REPORT_TYPE,
    aggregate_repeats,
    canonical_digest,
    evaluator_manifest_digest,
    task_matrix_digest,
)


def _matching_report_repeats(
    baseline: dict[str, Any], challenger: dict[str, Any]
) -> tuple[list[list[dict[str, Any]]], list[list[dict[str, Any]]]]:
    for report, label in ((baseline, "baseline"), (challenger, "challenger")):
        if report.get("evidence_type") != OUTCOME_REPORT_TYPE:
            raise ValueError(f"{label} evidence is not an autonomous outcome report")
    for field in ("benchmark_id", "split"):
        if baseline.get(field) != challenger.get(field):
            raise ValueError(f"outcome reports differ on {field}")
    baseline_repeats = baseline.get("repeats")
    challenger_repeats = challenger.get("repeats")
    if not isinstance(baseline_repeats, list) or not isinstance(challenger_repeats, list):
        raise ValueError("outcome reports must contain repeats")
    if len(baseline_repeats) != len(challenger_repeats):
        raise ValueError("outcome reports have different repeat counts")
    return baseline_repeats, challenger_repeats


def _shared_report_manifest(
    baseline: dict[str, Any], challenger: dict[str, Any]
) -> tuple[dict[str, str], str]:
    baseline_manifest = baseline.get("evaluator_manifest")
    challenger_manifest = challenger.get("evaluator_manifest")
    if not isinstance(baseline_manifest, dict) or not isinstance(challenger_manifest, dict):
        raise ValueError("outcome reports must contain evaluator manifests")
    if baseline_manifest != challenger_manifest:
        raise ValueError("outcome reports contain different evaluator manifests")
    manifest_digest = evaluator_manifest_digest(baseline_manifest)
    for report, label in ((baseline, "baseline"), (challenger, "challenger")):
        if report.get("evaluator_manifest_digest") != manifest_digest:
            raise ValueError(f"{label} evaluator_manifest_digest is invalid")
    return baseline_manifest, manifest_digest


def _matching_report_matrix(
    baseline: dict[str, Any],
    challenger: dict[str, Any],
    baseline_repeats: list[list[dict[str, Any]]],
    challenger_repeats: list[list[dict[str, Any]]],
    manifest_digest: str,
) -> str:
    baseline_matrix = task_matrix_digest(baseline_repeats, manifest_digest)
    challenger_matrix = task_matrix_digest(challenger_repeats, manifest_digest)
    for report, label, matrix, repeats in (
        (baseline, "baseline", baseline_matrix, baseline_repeats),
        (challenger, "challenger", challenger_matrix, challenger_repeats),
    ):
        if report.get("task_matrix_digest") != matrix:
            raise ValueError(f"{label} outcome report task_matrix_digest is invalid")
        if report.get("repeat_count") != len(repeats):
            raise ValueError(f"{label} outcome report repeat_count is invalid")
    if baseline_matrix != challenger_matrix:
        raise ValueError("outcome reports contain different task matrices")
    return challenger_matrix


def _pair_changes(
    repeat_index: int, baseline_repeat: list[dict[str, Any]], challenger_repeat: list[dict[str, Any]]
) -> tuple[list[str], list[str]]:
    baseline_by_id = {result["task_id"]: result for result in baseline_repeat}
    challenger_by_id = {result["task_id"]: result for result in challenger_repeat}
    if set(baseline_by_id) != set(challenger_by_id):
        raise ValueError("outcome reports contain different task IDs")
    wins: list[str] = []
    losses: list[str] = []
    for task_id in sorted(baseline_by_id):
        pair_id = f"repeat-{repeat_index}:{task_id}"
        change = _outcome_change(baseline_by_id[task_id], challenger_by_id[task_id])
        if change == "win":
            wins.append(pair_id)
        elif change == "loss":
            losses.append(pair_id)
    return wins, losses


def _outcome_change(baseline: dict[str, Any], challenger: dict[str, Any]) -> str | None:
    baseline_passed = baseline.get("verdict") == "pass"
    challenger_passed = challenger.get("verdict") == "pass"
    if challenger_passed and not baseline_passed:
        return "win"
    if baseline_passed and not challenger_passed:
        return "loss"
    return None


def _paired_changes(
    baseline_repeats: list[list[dict[str, Any]]], challenger_repeats: list[list[dict[str, Any]]]
) -> tuple[list[str], list[str]]:
    wins: list[str] = []
    losses: list[str] = []
    for repeat_index, (baseline_repeat, challenger_repeat) in enumerate(
        zip(baseline_repeats, challenger_repeats, strict=True)
    ):
        repeat_wins, repeat_losses = _pair_changes(repeat_index, baseline_repeat, challenger_repeat)
        wins.extend(repeat_wins)
        losses.extend(repeat_losses)
    return wins, losses


def _verified_report_aggregate(
    report: dict[str, Any], repeats: list[list[dict[str, Any]]], label: str
) -> dict[str, Any]:
    aggregate = report.get("aggregate")
    if not isinstance(aggregate, dict):
        raise ValueError("outcome reports must contain aggregate evidence")
    recomputed = aggregate_repeats(repeats)
    if aggregate != recomputed:
        raise ValueError(f"{label} outcome report aggregate is invalid")
    if report.get("task_attempt_count") != recomputed["task_attempt_count"]:
        raise ValueError(f"{label} outcome report task_attempt_count is invalid")
    return aggregate


def _usage_efficiency(
    baseline_usage: object, challenger_usage: object
) -> tuple[float, list[str]]:
    if not _complete_usage_pair(baseline_usage, challenger_usage):
        return 0.0, []
    baseline = cast(dict[str, Any], baseline_usage)
    challenger = cast(dict[str, Any], challenger_usage)
    gains: list[float] = []
    regressions: list[str] = []
    for field in ("agent_duration_seconds", "input_tokens", "output_tokens", "agent_calls"):
        before = float(baseline[field])
        after = float(challenger[field])
        if before > 0:
            gains.append((before - after) / before)
            if after > before * 1.2:
                regressions.append(f"resource-regression:{field}")
    return (round(min(gains), 4) if gains else 0.0), regressions


def _complete_usage_pair(baseline_usage: object, challenger_usage: object) -> bool:
    return (
        isinstance(baseline_usage, dict)
        and isinstance(challenger_usage, dict)
        and baseline_usage.get("measurement_status") == "complete"
        and challenger_usage.get("measurement_status") == "complete"
    )


def _efficiency_evidence(
    baseline_aggregate: dict[str, Any], challenger_aggregate: dict[str, Any], losses: list[str]
) -> tuple[float, list[str], Any]:
    challenger_usage = challenger_aggregate.get("resource_usage")
    efficiency_gain, regressions = _usage_efficiency(
        baseline_aggregate.get("resource_usage"), challenger_usage
    )
    return efficiency_gain, [*(f"paired-loss:{pair_id}" for pair_id in losses), *regressions], challenger_usage


def compare_outcome_reports(baseline: dict[str, Any], challenger: dict[str, Any]) -> dict[str, Any]:
    """Build paired optimizer evidence from two like-for-like outcome reports."""
    baseline_repeats, challenger_repeats = _matching_report_repeats(baseline, challenger)
    challenger_manifest, manifest_digest = _shared_report_manifest(baseline, challenger)
    challenger_matrix = _matching_report_matrix(
        baseline, challenger, baseline_repeats, challenger_repeats, manifest_digest
    )
    wins, losses = _paired_changes(baseline_repeats, challenger_repeats)
    baseline_aggregate = _verified_report_aggregate(baseline, baseline_repeats, "baseline")
    challenger_aggregate = _verified_report_aggregate(challenger, challenger_repeats, "challenger")
    efficiency_gain, hard_metric_regressions, challenger_usage = _efficiency_evidence(
        baseline_aggregate, challenger_aggregate, losses
    )
    return {
        "evidence_type": OUTCOME_COMPARISON_TYPE,
        "benchmark_id": challenger["benchmark_id"],
        "split": challenger["split"],
        "task_matrix_digest": challenger_matrix,
        "repeat_count": len(challenger_repeats),
        "task_attempt_count": challenger_aggregate.get("task_attempt_count"),
        "evaluator_manifest": challenger_manifest,
        "evaluator_manifest_digest": manifest_digest,
        "baseline_policy_id": baseline.get("policy_id"),
        "baseline_policy_digest": baseline.get("policy_digest"),
        "baseline_report_digest": canonical_digest(baseline),
        "challenger_report_digest": canonical_digest(challenger),
        "policy_id": challenger.get("policy_id"),
        "policy_digest": challenger.get("policy_digest"),
        "success_rate": challenger_aggregate.get("success_rate"),
        "paired_wins": len(wins),
        "paired_losses": len(losses),
        "paired_win_ids": wins,
        "paired_loss_ids": losses,
        "efficiency_gain": efficiency_gain,
        "hard_failure_classes": challenger_aggregate.get("hard_failure_classes", []),
        "hard_metric_regressions": hard_metric_regressions,
        "complete": bool(baseline_aggregate.get("complete")) and bool(challenger_aggregate.get("complete")),
        "resource_usage": challenger_usage,
        "status": "pass" if challenger_aggregate.get("status") == "pass" and not hard_metric_regressions else "fail",
    }
