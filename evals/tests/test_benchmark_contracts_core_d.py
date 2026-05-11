from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

from benchmark_contracts_helpers import RESULTS_ROOT, ROOT, repo_rel, write_json, write_release_gate_fixture
def test_release_gate_fails_when_calibration_report_is_missing() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-fail-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        result_path = output_dir / "result-tool-selection-core-dev-example.json"
        regression_path = output_dir / "regression-tool-selection-core-dev-example.json"
        ledger_path = output_dir / "result-ledger.jsonl"
        run_card_path = output_dir / "run-card-tool-selection-core-dev-example.json"
        gate_output_path = (
            output_dir / "release-gate-tool-selection-core-dev-example.json"
        )

        write_json(
            result_path,
            {
                "run_id": "tool-selection-core-dev-example",
                "benchmark_id": "tool-selection-core",
                "benchmark_version": "1.0.0",
                "split": "dev",
                "task_count": 1,
                "pass_count": 1,
                "fail_count": 0,
                "aggregate_metrics": {
                    "success_rate": 1.0,
                    "route_accuracy": 1.0,
                    "artifact_completeness": 1.0,
                    "checkpoint_compliance": 1.0,
                },
            },
        )
        write_json(
            regression_path,
            {
                "report_id": "regression-tool-selection-core-dev-example",
                "benchmark_id": "tool-selection-core",
                "split": "dev",
                "generated_at": "2026-04-15T00:00:00Z",
                "status": "pass",
                "baseline_result_path": "evals/results/baselines/tool-selection-core-dev.json",
                "aggregate_metrics": {
                    "success_rate": 1.0,
                    "route_accuracy": 1.0,
                    "artifact_completeness": 1.0,
                    "checkpoint_compliance": 1.0,
                },
                "baseline_metrics": {
                    "success_rate": 1.0,
                    "route_accuracy": 1.0,
                    "artifact_completeness": 1.0,
                    "checkpoint_compliance": 1.0,
                },
                "issues": [],
            },
        )
        ledger_path.write_text(
            json.dumps(
                {
                    "entry_id": "tool-selection-core-dev-example-aggregate",
                    "kind": "benchmark-run",
                    "timestamp": "2026-04-15T00:00:00Z",
                    "benchmark_id": "tool-selection-core",
                    "run_id": "tool-selection-core-dev-example",
                    "split": "dev",
                    "result_path": repo_rel(result_path),
                    "claim_links": benchmark["claim_links"],
                    "aggregate_metrics": {
                        "success_rate": 1.0,
                        "route_accuracy": 1.0,
                        "artifact_completeness": 1.0,
                        "checkpoint_compliance": 1.0,
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        write_json(
            run_card_path,
            {
                "run_id": "tool-selection-core-dev-example",
                "evidence_type": "benchmark-run",
                "benchmark_id": "tool-selection-core",
                "benchmark_version": "1.0.0",
                "date": "2026-04-15",
                "split": "dev",
                "system": {
                    "model": "rule-based-router-v1",
                    "runtime": "umbrella-benchmark-runner",
                },
                "judge_version": "programmatic-router-judge-v1",
                "command": "python3 evals/scripts/run_benchmark.py",
                "result_path": repo_rel(result_path),
                "status": "pass",
                "task_spec_path": "evals/datasets/tool-selection/tool-selection-core.task-specs.json",
                "routed_runtime": "mixed",
                "trace_paths": [],
                "artifact_paths": [],
                "checkpoint_paths": [],
                "claim_links": benchmark["claim_links"],
                "ledger_path": repo_rel(ledger_path),
                "regression_report_path": repo_rel(regression_path),
                "judge_calibration_report_path": repo_rel(
                    output_dir / "missing-calibration.json"
                ),
                "cost_usd": 0.0,
                "latency_seconds": 0.1,
                "notes": "test fixture",
            },
        )
        write_release_gate_fixture(
            output_dir / "held-out-pass",
            split="held-out",
            run_id="tool-selection-core-held-out-pass",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
            release_gate_status="pass",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/release_gate.py"),
                "--benchmark-card",
                str(benchmark_path),
                "--run-card",
                str(run_card_path),
                "--regression-report",
                str(regression_path),
                "--ledger",
                str(ledger_path),
                "--output",
                str(gate_output_path),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        gate_report = json.loads(gate_output_path.read_text(encoding="utf-8"))
        assert gate_report["status"] == "fail"
        assert "judge calibration report missing" in gate_report["issues"]


def test_validate_eval_metadata_rejects_invalid_workflow_verb_in_task_bundle() -> None:
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="validate-invalid-workflow-verb-"
    ) as tmp:
        task_bundle_path = pathlib.Path(tmp) / "invalid.task-specs.json"
        write_json(
            task_bundle_path,
            {
                "benchmark_id": "tmp-invalid-workflow-verb",
                "version": "1.0.0",
                "tasks": [
                    {
                        "task_id": "tmp-invalid-workflow-verb",
                        "title": "invalid workflow verb",
                        "split": "dev",
                        "family": "tmp",
                        "horizon": "single-step",
                        "expected_runtime": "tool",
                        "workflow_verb": "ship-it",
                    }
                ],
            },
        )

        completed = subprocess.run(
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "invalid workflow_verb" in (completed.stderr or completed.stdout)


def test_validate_eval_metadata_rejects_invalid_execution_profile_in_task_bundle() -> None:
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="validate-invalid-execution-profile-"
    ) as tmp:
        task_bundle_path = pathlib.Path(tmp) / "invalid.task-specs.json"
        write_json(
            task_bundle_path,
            {
                "benchmark_id": "tmp-invalid-execution-profile",
                "version": "1.0.0",
                "tasks": [
                    {
                        "task_id": "tmp-invalid-execution-profile",
                        "title": "invalid execution profile",
                        "split": "dev",
                        "family": "tmp",
                        "horizon": "single-step",
                        "expected_runtime": "tool",
                        "execution_profile": "orchestration-arm",
                    }
                ],
            },
        )

        completed = subprocess.run(
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "invalid execution_profile" in (completed.stderr or completed.stdout)


def test_validate_eval_metadata_rejects_execution_profile_runtime_mismatch() -> None:
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="validate-execution-profile-runtime-mismatch-"
    ) as tmp:
        task_bundle_path = pathlib.Path(tmp) / "mismatch.task-specs.json"
        write_json(
            task_bundle_path,
            {
                "benchmark_id": "tmp-execution-profile-runtime-mismatch",
                "version": "1.0.0",
                "tasks": [
                    {
                        "task_id": "tmp-execution-profile-runtime-mismatch",
                        "title": "execution profile runtime mismatch",
                        "split": "dev",
                        "family": "tmp",
                        "horizon": "single-step",
                        "expected_runtime": "tool",
                        "execution_profile": "orchestration-init",
                    }
                ],
            },
        )

        completed = subprocess.run(
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "execution_profile does not match expected_runtime" in (
            completed.stderr or completed.stdout
        )


def test_router_rejects_execution_profile_runtime_mismatch() -> None:
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="route-execution-profile-mismatch-"
    ) as tmp:
        tmp_path = pathlib.Path(tmp)
        task_path = tmp_path / "task.json"
        output_path = tmp_path / "run-card.json"
        write_json(
            task_path,
            {
                "task_id": "tmp-profile-runtime-mismatch",
                "title": "profile runtime mismatch",
                "split": "dev",
                "family": "tmp",
                "horizon": "single-step",
                "expected_runtime": "tool",
                "destructive_operation": True,
                "execution_profile": "orchestration-init",
            },
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/router.py"),
                "--task-spec",
                str(task_path),
                "--output",
                str(output_path),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "not routed runtime tool" in (completed.stderr or completed.stdout)


def test_router_rejects_non_string_execution_profile() -> None:
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="route-invalid-execution-profile-type-"
    ) as tmp:
        tmp_path = pathlib.Path(tmp)
        task_path = tmp_path / "task.json"
        output_path = tmp_path / "run-card.json"
        write_json(
            task_path,
            {
                "task_id": "tmp-invalid-execution-profile-type",
                "title": "invalid execution profile type",
                "split": "dev",
                "family": "tmp",
                "horizon": "single-step",
                "expected_runtime": "ralph",
                "execution_profile": False,
            },
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/router.py"),
                "--task-spec",
                str(task_path),
                "--output",
                str(output_path),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "execution_profile must be a non-empty string" in (
            completed.stderr or completed.stdout
        )
