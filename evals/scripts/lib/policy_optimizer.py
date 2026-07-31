"""Offline, evaluator-owned policy hill-climbing controller.

This module retains the public optimizer API.  Validation and evidence checks
live in focused sibling modules so the campaign controller stays reviewable.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass
from typing import Any, cast

from common import append_jsonl, dump_json, iso_timestamp

from lib.policy_optimizer_evidence import (
    _accept,
    _budget_exceeded,
    _hard_failure,
    _verified_evaluation,
)
from lib.policy_optimizer_policy import (
    MAX_CAMPAIGN_ITERATIONS,
    Evaluator,
    Policy,
    Proposer,
    policy_digest,
    trusted_manifest,
    validate_campaign,
    validate_candidate_policy_change,
    validate_policy,
)


@dataclass(frozen=True)
class _CampaignRun:
    """Keep campaign controls together after the public keyword boundary."""

    proposer: Proposer
    evaluator: Evaluator
    trusted_paths: list[pathlib.Path]
    output_dir: pathlib.Path
    max_iterations: int
    resource_budget: dict[str, float] | None
    sealed_evaluator: Evaluator | None
    candidate_change_allowlist: object


def _campaign_run(
    proposer: Proposer,
    evaluator: Evaluator,
    trusted_paths: list[pathlib.Path],
    output_dir: pathlib.Path,
    controls: dict[str, object],
) -> _CampaignRun:
    expected_controls = {
        "max_iterations",
        "resource_budget",
        "sealed_evaluator",
        "candidate_change_allowlist",
    }
    unexpected_controls = sorted(set(controls) - expected_controls)
    if unexpected_controls:
        raise TypeError(
            f"optimize_campaign() got an unexpected keyword argument {unexpected_controls[0]!r}"
        )
    if "max_iterations" not in controls:
        raise TypeError(
            "optimize_campaign() missing 1 required keyword-only argument: 'max_iterations'"
        )
    return _CampaignRun(
        proposer=proposer,
        evaluator=evaluator,
        trusted_paths=trusted_paths,
        output_dir=output_dir,
        max_iterations=cast(int, controls["max_iterations"]),
        resource_budget=cast(dict[str, float] | None, controls.get("resource_budget")),
        sealed_evaluator=cast(Evaluator | None, controls.get("sealed_evaluator")),
        candidate_change_allowlist=controls.get("candidate_change_allowlist"),
    )


def _record_event(
    lineage: list[dict[str, Any]], lineage_path: pathlib.Path, event: dict[str, Any]
) -> None:
    lineage.append(event)
    append_jsonl(lineage_path, event)


def recover_lineage(lineage_path: pathlib.Path) -> list[dict[str, Any]]:
    """Read append-only lineage without treating a partial record as evidence."""
    if not lineage_path.exists():
        return []
    recovered: list[dict[str, Any]] = []
    for line_number, line in enumerate(lineage_path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"lineage recovery failed at line {line_number}") from exc
        if not isinstance(event, dict):
            raise ValueError(f"lineage recovery found a non-object event at line {line_number}")
        recovered.append(event)
    return recovered


def _campaign_baseline(
    baseline_policy: Policy,
    evaluator: Evaluator,
    output_dir: pathlib.Path,
    trusted_paths: list[pathlib.Path],
) -> tuple[dict[str, str], dict[str, Any]]:
    initial_manifest = trusted_manifest(trusted_paths)
    dump_json(output_dir / "trusted-manifest.json", initial_manifest)
    baseline_eval = _verified_evaluation(
        baseline_policy,
        evaluator(baseline_policy),
        allowed_evidence_types=frozenset({"autonomous-outcome-report"}),
    )
    _require_campaign_manifest(baseline_eval, initial_manifest)
    return initial_manifest, baseline_eval


def _candidate_or_rejection(
    proposer: Proposer,
    incumbent: Policy,
    lineage: list[dict[str, Any]],
    iteration: int,
    lineage_path: pathlib.Path,
    candidate_change_allowlist: object,
) -> tuple[Policy | None, str]:
    candidate = proposer(incumbent, lineage)
    candidate_id = f"candidate-{iteration:02d}"
    try:
        validate_policy(candidate)
        validate_candidate_policy_change(incumbent, candidate, candidate_change_allowlist)
    except ValueError as exc:
        _record_event(
            lineage,
            lineage_path,
            {
                "iteration": iteration,
                "candidate_id": candidate_id,
                "decision": "rejected",
                "reason": str(exc),
            },
        )
        return None, candidate_id
    return candidate, candidate_id


def _candidate_evaluation(
    candidate: Policy,
    evaluator: Evaluator,
    baseline_eval: dict[str, Any],
    manifest: dict[str, str],
) -> dict[str, Any]:
    evaluation = _verified_evaluation(
        candidate,
        evaluator(candidate),
        allowed_evidence_types=frozenset({"autonomous-outcome-report"}),
    )
    _require_campaign_manifest(evaluation, manifest)
    _assert_same_development_matrix(baseline_eval, evaluation)
    return evaluation


def _accepted_candidate(
    incumbent: Policy,
    incumbent_eval: dict[str, Any],
    candidate: Policy,
    evaluation: dict[str, Any],
) -> tuple[bool, dict[str, Any]]:
    from lib.outcome_eval import compare_outcome_reports

    comparison = _verified_evaluation(
        candidate,
        compare_outcome_reports(incumbent_eval, evaluation),
        allowed_evidence_types=frozenset({"autonomous-outcome-comparison"}),
    )
    if comparison["baseline_policy_id"] != incumbent["policy_id"]:
        raise ValueError("comparison baseline policy does not match the incumbent")
    if comparison["baseline_policy_digest"] != policy_digest(incumbent):
        raise ValueError("comparison baseline digest does not match the incumbent")
    accepted, _ = _accept(incumbent_eval, comparison)
    return accepted, comparison


def _require_campaign_manifest(
    evaluation: dict[str, Any], campaign_manifest: dict[str, str]
) -> None:
    evidence_manifest = evaluation["evaluator_manifest"]
    if evidence_manifest == campaign_manifest:
        return
    missing = sorted(set(campaign_manifest) - set(evidence_manifest))
    extra = sorted(set(evidence_manifest) - set(campaign_manifest))
    changed = sorted(
        path
        for path in set(campaign_manifest) & set(evidence_manifest)
        if campaign_manifest[path] != evidence_manifest[path]
    )
    details = [
        *(f"missing:{path}" for path in missing[:3]),
        *(f"extra:{path}" for path in extra[:3]),
        *(f"changed:{path}" for path in changed[:3]),
    ]
    raise ValueError(
        "evaluation does not exactly match the campaign trusted manifest: " + ", ".join(details)
    )


def _assert_same_development_matrix(baseline: dict[str, Any], challenger: dict[str, Any]) -> None:
    for field in ("benchmark_id", "split", "task_matrix_digest", "repeat_count"):
        if baseline.get(field) != challenger.get(field):
            raise ValueError(f"development evaluations differ on {field}")


def _sealed_evaluation(
    incumbent: Policy,
    incumbent_eval: dict[str, Any],
    sealed_evaluator: Evaluator | None,
) -> dict[str, Any] | None:
    if sealed_evaluator is None:
        return None
    from lib.policy_optimizer_evidence import _verified_sealed_evaluation

    return _verified_sealed_evaluation(incumbent, sealed_evaluator(incumbent), incumbent_eval)


def _finish_campaign(
    baseline_policy: Policy,
    state: dict[str, Any],
    trusted_paths: list[pathlib.Path],
    output_dir: pathlib.Path,
    sealed_evaluator: Evaluator | None,
) -> dict[str, Any]:
    incumbent = state["incumbent"]
    incumbent_eval = state["incumbent_eval"]
    sealed = _sealed_evaluation(incumbent, incumbent_eval, sealed_evaluator)
    if sealed is not None:
        _require_campaign_manifest(sealed, state["initial_manifest"])
        dump_json(output_dir / "sealed-evaluation.json", sealed)
    accepted_any = any(event.get("decision") == "accepted" for event in state["lineage"])
    sealed_passed = bool(sealed and not _hard_failure(sealed) and sealed.get("status") == "pass")
    manifest_intact = trusted_manifest(trusted_paths) == state["initial_manifest"]
    recommendation_ready = accepted_any and sealed_passed and manifest_intact
    report = _campaign_report(baseline_policy, state, sealed, manifest_intact, recommendation_ready)
    dump_json(output_dir / "campaign-report.json", report)
    if recommendation_ready:
        dump_json(output_dir / "recommended-policy.json", incumbent)
    return report


def _campaign_report(
    baseline_policy: Policy,
    state: dict[str, Any],
    sealed: dict[str, Any] | None,
    manifest_intact: bool,
    recommendation_ready: bool,
) -> dict[str, Any]:
    return {
        "generated_at": iso_timestamp(),
        "status": "completed" if manifest_intact else "blocked",
        "iterations": len(state["lineage"]),
        "baseline_policy_digest": policy_digest(baseline_policy),
        "incumbent_policy_digest": policy_digest(state["incumbent"]),
        "baseline_evaluation": state["baseline_eval"],
        "incumbent_evaluation": state["incumbent_eval"],
        "lineage_path": "lineage.jsonl",
        "resource_spent": state["spent"],
        "automatic_promotion": False,
        "recommendation_status": "recommended" if recommendation_ready else "no-recommendation",
        "sealed_evaluation": sealed,
    }


def _evaluate_iteration(
    state: dict[str, Any],
    candidate: Policy,
    evaluator: Evaluator,
    resource_budget: dict[str, float] | None,
) -> tuple[bool, dict[str, Any], dict[str, Any] | None]:
    evaluation = _candidate_evaluation(
        candidate, evaluator, state["baseline_eval"], state["initial_manifest"]
    )
    if _budget_exceeded(state["spent"], evaluation, resource_budget):
        return True, evaluation, None
    accepted, comparison = _accepted_candidate(
        state["incumbent"], state["incumbent_eval"], candidate, evaluation
    )
    return False, evaluation, {"accepted": accepted, "comparison": comparison}


def _record_iteration(
    state: dict[str, Any],
    lineage_path: pathlib.Path,
    iteration: int,
    candidate_id: str,
    candidate: Policy,
    evaluation: dict[str, Any],
    decision: dict[str, Any],
    output_dir: pathlib.Path,
) -> None:
    comparison = decision["comparison"]
    accepted = decision["accepted"]
    _, reason = _accept(state["incumbent_eval"], comparison)
    _record_event(
        state["lineage"],
        lineage_path,
        {
            "iteration": iteration,
            "candidate_id": candidate_id,
            "policy_id": candidate["policy_id"],
            "policy_digest": policy_digest(candidate),
            "decision": "accepted" if accepted else "rejected",
            "reason": reason,
            "success_rate": comparison.get("success_rate"),
            "hard_failure_classes": comparison.get("hard_failure_classes", []),
        },
    )
    dump_json(output_dir / "evaluations" / f"{candidate_id}.json", evaluation)
    dump_json(output_dir / "comparisons" / f"{candidate_id}.json", comparison)
    if accepted:
        state["incumbent"], state["incumbent_eval"] = candidate, evaluation


def optimize_campaign(
    *,
    baseline_policy: Policy,
    proposer: Proposer,
    evaluator: Evaluator,
    trusted_paths: list[pathlib.Path],
    output_dir: pathlib.Path,
    **controls: object,
) -> dict[str, Any]:
    """Run a bounded single-challenger campaign with fully retained lineage."""
    campaign = _campaign_run(proposer, evaluator, trusted_paths, output_dir, controls)
    state, lineage_path = _start_campaign(
        baseline_policy,
        campaign.evaluator,
        campaign.trusted_paths,
        campaign.output_dir,
        campaign.max_iterations,
    )
    _run_iterations(state, lineage_path, campaign)
    return _finish_campaign(
        baseline_policy,
        state,
        campaign.trusted_paths,
        campaign.output_dir,
        campaign.sealed_evaluator,
    )


def _start_campaign(
    baseline_policy: Policy,
    evaluator: Evaluator,
    trusted_paths: list[pathlib.Path],
    output_dir: pathlib.Path,
    max_iterations: int,
) -> tuple[dict[str, Any], pathlib.Path]:
    if not 1 <= max_iterations <= MAX_CAMPAIGN_ITERATIONS:
        raise ValueError("max_iterations must be between 1 and 10")
    validate_policy(baseline_policy)
    if output_dir.exists() and (not output_dir.is_dir() or any(output_dir.iterdir())):
        raise ValueError("optimizer output_dir must be absent or empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    initial_manifest, baseline_eval = _campaign_baseline(
        baseline_policy, evaluator, output_dir, trusted_paths
    )
    state: dict[str, Any] = {
        "initial_manifest": initial_manifest,
        "baseline_eval": baseline_eval,
        "incumbent": baseline_policy,
        "incumbent_eval": baseline_eval,
        "lineage": [],
        "spent": {},
    }
    return state, output_dir / "lineage.jsonl"


def _record_blocked_iteration(
    state: dict[str, Any],
    lineage_path: pathlib.Path,
    iteration: int,
    reason: str,
    candidate_id: str | None = None,
) -> None:
    event: dict[str, Any] = {"iteration": iteration, "decision": "blocked", "reason": reason}
    if candidate_id is not None:
        event["candidate_id"] = candidate_id
    _record_event(state["lineage"], lineage_path, event)


def _run_iterations(
    state: dict[str, Any],
    lineage_path: pathlib.Path,
    campaign: _CampaignRun,
) -> None:
    for iteration in range(1, campaign.max_iterations + 1):
        if trusted_manifest(campaign.trusted_paths) != state["initial_manifest"]:
            _record_blocked_iteration(state, lineage_path, iteration, "evaluator-integrity-drift")
            break
        candidate, candidate_id = _candidate_or_rejection(
            campaign.proposer,
            state["incumbent"],
            state["lineage"],
            iteration,
            lineage_path,
            campaign.candidate_change_allowlist,
        )
        if candidate is None:
            continue
        dump_json(campaign.output_dir / "candidates" / f"{candidate_id}.policy.json", candidate)
        budget_blocked, evaluation, decision = _evaluate_iteration(
            state, candidate, campaign.evaluator, campaign.resource_budget
        )
        if budget_blocked:
            _record_blocked_iteration(
                state,
                lineage_path,
                iteration,
                "budget-exceeded-or-incomplete-measurement",
                candidate_id,
            )
            dump_json(campaign.output_dir / "evaluations" / f"{candidate_id}.json", evaluation)
            break
        if decision is None:
            raise RuntimeError("policy search did not produce a decision")
        _record_iteration(
            state,
            lineage_path,
            iteration,
            candidate_id,
            candidate,
            evaluation,
            decision,
            campaign.output_dir,
        )


__all__ = [
    "optimize_campaign",
    "policy_digest",
    "recover_lineage",
    "trusted_manifest",
    "validate_campaign",
    "validate_policy",
]
