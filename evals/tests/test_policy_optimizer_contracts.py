"""Policy, resource, and sealed-evidence contracts for the offline optimizer."""

__test__ = False

import pathlib
import tempfile
from typing import Any

from outcome_optimizer_helpers import (
    OUTCOME_REPORT_TYPE,
    RESULTS_ROOT,
    TRUSTED_EVALUATOR_PATH,
    aggregate_repeats,
    evaluation,
    optimize_campaign,
    policy,
    resource_usage_issues,
)


def test_optimizer_accepts_only_measurable_improvement_without_auto_promotion() -> None:
    baseline = policy()
    candidate = policy("candidate")
    candidate["phase_guidance"]["plan"] = "improved"

    def evaluator(evaluated: dict[str, Any]) -> dict[str, Any]:
        return evaluation(
            evaluated,
            1.0 if evaluated["policy_id"] == "candidate" else 0.5,
            evidence_type=OUTCOME_REPORT_TYPE,
        )

    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-") as tmp:
        output = pathlib.Path(tmp)
        report = optimize_campaign(
            baseline_policy=baseline,
            proposer=lambda _incumbent, _lineage: candidate,
            evaluator=evaluator,
            trusted_paths=[TRUSTED_EVALUATOR_PATH],
            output_dir=output,
            max_iterations=1,
            sealed_evaluator=lambda evaluated: evaluation(
                evaluated,
                1.0,
                split="held-out",
                evidence_type=OUTCOME_REPORT_TYPE,
            ),
        )
        assert (output / "recommended-policy.json").exists()
    assert report["automatic_promotion"] is False
    assert report["incumbent_evaluation"]["success_rate"] == 1.0


def test_resource_policy_rejects_unknown_token_measurement_without_zero_fill() -> None:
    benchmark = {"resource_policy": {"require_measurement": True, "max_total_tokens": 100}}
    card = {
        "resource_usage": {
            "measurement_status": "partial",
            "agent_duration_seconds": 1.0,
            "agent_calls": 1,
            "max_parallelism": 1,
            "missing_measurements": ["input_tokens"],
        }
    }
    issues = resource_usage_issues(benchmark, card)
    assert "run card resource measurement is not complete" in issues
    assert "run card lacks total-token measurement" in issues


def test_resource_policy_with_a_limit_rejects_missing_usage_even_without_require_flag() -> None:
    benchmark = {"resource_policy": {"max_agent_calls": 2}}
    assert resource_usage_issues(benchmark, {}) == ["run card missing resource_usage"]


def test_optimizer_blocks_budgeted_campaign_when_usage_is_incomplete() -> None:
    baseline = policy()

    def incomplete_evaluation(evaluated: dict[str, Any]) -> dict[str, Any]:
        evidence = evaluation(evaluated, 0.5, evidence_type=OUTCOME_REPORT_TYPE)
        for result in evidence["repeats"][0]:
            result["resource_usage"] = {
                "measurement_status": "incomplete",
                "missing_measurements": ["input_tokens"],
            }
        evidence["aggregate"] = aggregate_repeats(evidence["repeats"])
        return evidence

    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-budget-") as tmp:
        output = pathlib.Path(tmp)
        report = optimize_campaign(
            baseline_policy=baseline,
            proposer=lambda _incumbent, _lineage: baseline,
            evaluator=incomplete_evaluation,
            trusted_paths=[TRUSTED_EVALUATOR_PATH],
            output_dir=output,
            max_iterations=1,
            resource_budget={"max_total_tokens": 10},
        )
        lineage = (output / "lineage.jsonl").read_text(encoding="utf-8")
    assert report["resource_spent"] == {}
    assert "budget-exceeded-or-incomplete-measurement" in lineage


def test_optimizer_never_emits_recommendation_without_a_passing_sealed_result() -> None:
    baseline, candidate = policy(), policy("candidate")
    candidate["phase_guidance"]["plan"] = "improved"
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-sealed-") as tmp:
        output = pathlib.Path(tmp)
        report = optimize_campaign(
            baseline_policy=baseline,
            proposer=lambda _incumbent, _lineage: candidate,
            evaluator=lambda evaluated: evaluation(
                evaluated,
                1.0 if evaluated["policy_id"] == "candidate" else 0.5,
                evidence_type=OUTCOME_REPORT_TYPE,
            ),
            trusted_paths=[TRUSTED_EVALUATOR_PATH],
            output_dir=output,
            max_iterations=1,
        )
        assert not (output / "recommended-policy.json").exists()
    assert report["recommendation_status"] == "no-recommendation"


def test_optimizer_rejects_development_evidence_as_a_sealed_result() -> None:
    baseline, candidate = policy(), policy("candidate")
    candidate["phase_guidance"]["plan"] = "improved"
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-unsealed-") as tmp:
        output = pathlib.Path(tmp)
        try:
            optimize_campaign(
                baseline_policy=baseline,
                proposer=lambda _incumbent, _lineage: candidate,
                evaluator=lambda evaluated: evaluation(
                    evaluated,
                    1.0 if evaluated["policy_id"] == "candidate" else 0.5,
                    evidence_type=OUTCOME_REPORT_TYPE,
                ),
                trusted_paths=[TRUSTED_EVALUATOR_PATH],
                output_dir=output,
                max_iterations=1,
                sealed_evaluator=lambda evaluated: evaluation(
                    evaluated,
                    1.0,
                    evidence_type=OUTCOME_REPORT_TYPE,
                ),
            )
        except ValueError as exc:
            assert "split must be held-out" in str(exc)
        else:
            raise AssertionError("development evidence was accepted as sealed evidence")
        assert not (output / "recommended-policy.json").exists()


def test_optimizer_rejects_out_of_range_reports_and_standalone_comparisons() -> None:
    baseline = policy()
    bad_score = evaluation(baseline, 0.5, evidence_type=OUTCOME_REPORT_TYPE)
    bad_score["aggregate"] = {**bad_score["aggregate"], "success_rate": 2.0}
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-forged-") as tmp:
        try:
            optimize_campaign(
                baseline_policy=baseline,
                proposer=lambda incumbent, _lineage: incumbent,
                evaluator=lambda _evaluated: bad_score,
                trusted_paths=[TRUSTED_EVALUATOR_PATH],
                output_dir=pathlib.Path(tmp),
                max_iterations=1,
            )
        except ValueError as exc:
            assert "between 0 and 1" in str(exc)
        else:
            raise AssertionError("out-of-range optimizer score was accepted")

    comparison_only = evaluation(baseline, 0.5)
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-optimizer-pairs-") as tmp:
        try:
            optimize_campaign(
                baseline_policy=baseline,
                proposer=lambda incumbent, _lineage: incumbent,
                evaluator=lambda _evaluated: comparison_only,
                trusted_paths=[TRUSTED_EVALUATOR_PATH],
                output_dir=pathlib.Path(tmp),
                max_iterations=1,
            )
        except ValueError as exc:
            assert "evidence_type is not accepted" in str(exc)
        else:
            raise AssertionError("standalone comparison evidence was accepted")
