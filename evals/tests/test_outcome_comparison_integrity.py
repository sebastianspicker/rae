"""Comparison and evaluator-manifest integrity contracts."""

__test__ = False

import json
import pathlib
import tempfile

from outcome_optimizer_helpers import (
    OUTCOME_COMPARISON_TYPE,
    OUTCOME_REPORT_TYPE,
    RESULTS_ROOT,
    ROOT,
    TRUSTED_EVALUATOR_PATH,
    build_evaluator_manifest,
    compare_outcome_reports,
    comparison_reports,
    evaluation,
    evaluator_manifest_digest,
    optimize_campaign,
    policy,
    task,
    task_matrix_digest,
    trusted_manifest,
)


def test_paired_outcome_comparison_binds_candidate_policy_and_keeps_losses() -> None:
    baseline, challenger = comparison_reports()
    comparison = compare_outcome_reports(baseline, challenger)
    assert comparison["evidence_type"] == OUTCOME_COMPARISON_TYPE
    assert comparison["task_matrix_digest"] == baseline["task_matrix_digest"]
    assert comparison["baseline_policy_id"] == "baseline"
    assert comparison["baseline_policy_digest"] == "a" * 64
    assert comparison["baseline_report_digest"] != comparison["challenger_report_digest"]
    assert comparison["policy_id"] == "candidate"
    assert comparison["paired_wins"] == 1
    assert comparison["paired_losses"] == 0


def test_comparison_recomputes_source_report_aggregates() -> None:
    baseline = evaluation(policy(), 0.0, evidence_type=OUTCOME_REPORT_TYPE)
    challenger = evaluation(policy("candidate"), 1.0, evidence_type=OUTCOME_REPORT_TYPE)
    for report in (baseline, challenger):
        report["task_attempt_count"] = report["aggregate"]["task_attempt_count"]
    challenger["aggregate"] = {**challenger["aggregate"], "success_rate": 0.75}
    try:
        compare_outcome_reports(baseline, challenger)
    except ValueError as exc:
        assert "challenger outcome report aggregate is invalid" in str(exc)
    else:
        raise AssertionError("a forged source aggregate was accepted")


def test_evaluator_manifest_binds_fixture_content_under_stable_task_ids() -> None:
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-manifest-") as tmp:
        root = pathlib.Path(tmp)
        fixture_root = root / "fixtures"
        fixture = fixture_root / "stable-fixture"
        fixture.mkdir(parents=True)
        source = fixture / "app.py"
        source.write_text("value = 1\n", encoding="utf-8")
        evaluated_task = {**task(), "fixture_id": "stable-fixture"}
        bundle_path = root / "bundle.json"
        bundle_path.write_text(
            json.dumps(
                {
                    "benchmark_id": "stable-task-id",
                    "status": "experimental",
                    "tasks": [evaluated_task],
                }
            ),
            encoding="utf-8",
        )
        before = build_evaluator_manifest(
            bundle_path=bundle_path,
            tasks=[evaluated_task],
            fixture_root=fixture_root,
        )
        source.write_text("value = 2\n", encoding="utf-8")
        after = build_evaluator_manifest(
            bundle_path=bundle_path,
            tasks=[evaluated_task],
            fixture_root=fixture_root,
        )
    assert evaluator_manifest_digest(before) != evaluator_manifest_digest(after)


def test_optimizer_requires_the_exact_campaign_manifest_without_extra_paths() -> None:
    baseline = policy()
    report = evaluation(baseline, 0.5, evidence_type=OUTCOME_REPORT_TYPE)
    report["evaluator_manifest"] = {
        **report["evaluator_manifest"],
        "does/not/exist.py": "a" * 64,
    }
    report["evaluator_manifest_digest"] = evaluator_manifest_digest(report["evaluator_manifest"])
    report["task_matrix_digest"] = task_matrix_digest(
        report["repeats"], report["evaluator_manifest_digest"]
    )
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-manifest-extra-") as tmp:
        try:
            optimize_campaign(
                baseline_policy=baseline,
                proposer=lambda incumbent, _lineage: incumbent,
                evaluator=lambda _evaluated: report,
                trusted_paths=[TRUSTED_EVALUATOR_PATH],
                output_dir=pathlib.Path(tmp),
                max_iterations=1,
            )
        except ValueError as exc:
            assert "exactly match the campaign trusted manifest" in str(exc)
        else:
            raise AssertionError("an extra self-authenticating manifest path was accepted")


def test_default_campaign_lists_the_complete_evaluator_manifest() -> None:
    campaign = json.loads(
        (ROOT / "evals/campaigns/autonomous-policy.experimental.json").read_text(encoding="utf-8")
    )
    bundle_path = ROOT / "evals/datasets/autonomous-outcomes/core.task-bundle.json"
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    actual = build_evaluator_manifest(
        bundle_path=bundle_path,
        tasks=bundle["tasks"],
        fixture_root=ROOT / "evals/fixtures/autonomous-outcomes",
    )
    declared = trusted_manifest([ROOT / path for path in campaign["trusted_paths"]])
    assert declared == actual
