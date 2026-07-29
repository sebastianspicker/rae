"""Contract tests for rejecting unsafe evaluation metadata and routing mismatches."""

import json
import pathlib
import subprocess
import sys
import tempfile

from benchmark_contracts_helpers import (
    RESULTS_ROOT,
    ROOT,
    calibration_payload,
    run_release_gate,
    write_json,
    write_release_gate_fixture,
)


def test_validate_eval_metadata_rejects_absolute_benchmark_paths() -> None:
    source = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(source.read_text(encoding="utf-8"))
    benchmark["benchmark_id"] = "tmp-absolute-scenario-path"
    benchmark["scenario_path"] = str(ROOT / "evals/scenarios/tool-selection")
    temp_path = RESULTS_ROOT / ".tmp-absolute-scenario-path.benchmark-card.json"
    write_json(temp_path, benchmark)
    try:
        # Fixed repository validator under the current test interpreter.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
    finally:
        temp_path.unlink(missing_ok=True)
    assert completed.returncode != 0
    assert "scenario_path must be repository-relative" in (completed.stderr or completed.stdout)


def test_validate_eval_metadata_rejects_parent_traversal() -> None:
    source = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(source.read_text(encoding="utf-8"))
    benchmark["benchmark_id"] = "tmp-parent-traversal"
    benchmark["scenario_path"] = "evals/scenarios/../benchmarks"
    temp_path = RESULTS_ROOT / ".tmp-parent-traversal.benchmark-card.json"
    write_json(temp_path, benchmark)
    try:
        # Fixed repository validator under the current test interpreter.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
    finally:
        temp_path.unlink(missing_ok=True)
    assert completed.returncode != 0
    assert "scenario_path must be repository-relative" in (completed.stderr or completed.stdout)


def test_validate_eval_metadata_rejects_absolute_run_result_path() -> None:
    source = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(source.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="validate-absolute-result-path-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        result_path, _, _, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-absolute-result-path",
            benchmark=benchmark,
        )
        run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
        run_card["result_path"] = str(result_path)
        write_json(run_card_path, run_card)
        # Fixed repository validator under the current test interpreter.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
    assert completed.returncode != 0
    assert "result_path must be repository-relative" in (completed.stderr or completed.stdout)


def test_release_gate_fails_when_calibration_report_is_missing() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="release-gate-fail-") as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir, split="dev", run_id="tool-selection-core-dev-example", benchmark=benchmark
        )
        gate_output_path = output_dir / "release-gate-tool-selection-core-dev-example.json"
        write_release_gate_fixture(
            output_dir / "held-out-pass",
            split="held-out",
            run_id="tool-selection-core-held-out-pass",
            benchmark=benchmark,
            calibration_payload=calibration_payload(),
            release_gate_status="pass",
        )
        gate_output_path = output_dir / "release-gate-tool-selection-core-dev-example.json"

        completed = run_release_gate(
            benchmark_path, run_card_path, regression_path, ledger_path, gate_output_path
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

        # B603 rationale: fixed interpreter and repository test entrypoint.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
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

        # B603 rationale: fixed interpreter and repository test entrypoint.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
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

        # B603 rationale: fixed interpreter and repository test entrypoint.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
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

        # B603 rationale: fixed interpreter and repository test entrypoint.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
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

        # B603 rationale: fixed interpreter and repository test entrypoint.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
        completed = subprocess.run(  # nosec B603
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
