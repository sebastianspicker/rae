"""Contract tests for evidence containment, timeout provenance, and calibration."""

import json
import pathlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import pytest
from benchmark_contracts_helpers import (
    RESULTS_ROOT,
    ROOT,
    calibration_payload,
    load_module,
    repo_rel,
    run_release_gate,
    write_json,
    write_passing_held_out_fixture,
    write_release_gate_fixture,
)


def _write_foreign_command_log(path: pathlib.Path) -> None:
    write_json(
        path,
        {
            "argv": ["foreign"],
            "cwd": ".",
            "returncode": 0,
            "stdout": "",
            "stderr": "",
            "duration_seconds": 0.1,
        },
    )


def _write_outside_run_card(
    path: pathlib.Path, benchmark: dict, paths: tuple[pathlib.Path, ...]
) -> None:
    result, regression, ledger, calibration = paths
    write_json(
        path,
        {
            "run_id": "tool-selection-core-dev-outside-run-card",
            "evidence_type": "benchmark-run",
            "benchmark_id": benchmark["benchmark_id"],
            "benchmark_version": benchmark["version"],
            "date": "2026-04-15",
            "split": "dev",
            "system": {"model": "rule-based-router-v1", "runtime": "umbrella-benchmark-runner"},
            "judge_version": "programmatic-router-judge-v1",
            "command": "python3 evals/scripts/run_benchmark.py",
            "result_path": repo_rel(result),
            "status": "pass",
            "task_spec_path": benchmark["task_specs_path"],
            "routed_runtime": "mixed",
            "trace_paths": [],
            "artifact_paths": [],
            "checkpoint_paths": [],
            "claim_links": benchmark["claim_links"],
            "ledger_path": repo_rel(ledger),
            "regression_report_path": repo_rel(regression),
            "judge_calibration_report_path": repo_rel(calibration),
            "cost_usd": 0.0,
            "latency_seconds": 0.1,
            "notes": "test fixture",
        },
    )


def test_release_gate_rejects_verification_evidence_outside_current_run_scope() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-forged-evidence-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-forged-evidence",
            benchmark=benchmark,
            calibration_payload=calibration_payload(),
            verification_evidence={
                "required_types": ["command-log"],
                "provided": [],
                "summary": {
                    "status": "complete",
                    "provided_types": ["command-log"],
                    "missing_types": [],
                    "residual_gaps": [],
                },
            },
        )
        foreign_dir = output_dir.parent / "foreign-evidence"
        foreign_command_log = foreign_dir / "foreign.command-result.json"
        _write_foreign_command_log(foreign_command_log)
        run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
        run_card["verification_evidence"]["provided"] = [
            {
                "task_id": "tool-selection-dev-orchestration",
                "type": "command-log",
                "path": repo_rel(foreign_command_log),
            }
        ]
        write_json(run_card_path, run_card)
        write_passing_held_out_fixture(output_dir, benchmark)
        gate_output_path = output_dir / "release-gate-tool-selection-core-dev-forged-evidence.json"

        completed = run_release_gate(
            benchmark_path, run_card_path, regression_path, ledger_path, gate_output_path
        )

        assert completed.returncode != 0
        gate_report = json.loads(gate_output_path.read_text(encoding="utf-8"))
        assert any(
            "verification_evidence.provided[0] path outside current run scope" in issue
            for issue in gate_report["issues"]
        )


def test_release_gate_does_not_mutate_run_card_outside_results_root() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(prefix="release-gate-outside-run-card-") as outside_tmp:
        outside_dir = pathlib.Path(outside_tmp)
        with tempfile.TemporaryDirectory(
            dir=RESULTS_ROOT, prefix="release-gate-outside-run-card-output-"
        ) as output_tmp:
            output_dir = pathlib.Path(output_tmp)
            result_path, regression_path, ledger_path, calibration_path, _ = (
                write_release_gate_fixture(
                    output_dir,
                    split="dev",
                    run_id="tool-selection-core-dev-outside-run-card",
                    benchmark=benchmark,
                    calibration_payload=calibration_payload(),
                )
            )
            run_card_path = outside_dir / "run-card-tool-selection-core-dev-outside-run-card.json"
            _write_outside_run_card(
                run_card_path,
                benchmark,
                (result_path, regression_path, ledger_path, calibration_path),
            )
            write_passing_held_out_fixture(output_dir, benchmark)
            gate_output_path = (
                output_dir / "release-gate-tool-selection-core-dev-outside-run-card.json"
            )

            completed = run_release_gate(
                benchmark_path, run_card_path, regression_path, ledger_path, gate_output_path
            )

            assert completed.returncode != 0
            updated_run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
            assert "release_gate_status" not in updated_run_card
            assert "release_gate_report_path" not in updated_run_card


def test_run_command_marks_timeouts_with_provenance() -> None:
    common = load_module("evals_common", "evals/scripts/common.py")

    result = common.run_command(
        [sys.executable, "-c", "import time; time.sleep(0.2)"],
        cwd=ROOT,
        timeout_seconds=0.05,
    )

    assert result["returncode"] == 124
    assert result["timed_out"] is True
    assert result["argv"] == [sys.executable, "-c", "import time; time.sleep(0.2)"]
    assert result["timeout_seconds"] == 0.05
    assert "timed out" in result["stderr"]


def test_run_command_rejects_unsupported_and_path_shadowed_executables() -> None:
    common = load_module("evals_common_rejections", "evals/scripts/common.py")

    with pytest.raises(ValueError, match="unsupported executable"):
        common.run_command(["sh", "-c", "exit 0"], cwd=ROOT)

    with tempfile.TemporaryDirectory(prefix="rae-shadowed-path-") as tmp:
        fake_node = pathlib.Path(tmp) / "node"
        fake_node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        fake_node.chmod(0o755)
        with pytest.raises(ValueError, match="PATH-shadowed"):
            common.run_command(
                ["node", "scripts/pipeline/runner.mjs", "--help"],
                cwd=ROOT / "packages/orchestration",
                env={"PATH": tmp},
            )


def test_run_command_confines_node_entrypoint_to_package_root() -> None:
    common = load_module("evals_common_node_confinement", "evals/scripts/common.py")
    package_root = ROOT / "packages/orchestration"

    with pytest.raises(ValueError, match="below the package root"):
        common.run_command(["node", str(ROOT / "scripts/verify_repo.py")], cwd=package_root)


def test_run_command_preserves_nonzero_exit_and_rejects_malformed_output(monkeypatch) -> None:
    common = load_module("evals_common_output_contract", "evals/scripts/common.py")
    exited = common.run_command([sys.executable, "-c", "raise SystemExit(7)"], cwd=ROOT)
    assert exited["argv"] == [sys.executable, "-c", "raise SystemExit(7)"]
    assert exited["returncode"] == 7
    assert exited["timed_out"] is False

    monkeypatch.setattr(
        common.subprocess,
        "Popen",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            communicate=lambda timeout=None: (object(), ""),
        ),
    )
    with pytest.raises(RuntimeError, match="malformed non-text output"):
        common.run_command([sys.executable, "-c", "pass"], cwd=ROOT)


def test_run_benchmark_propagates_calibration_subprocess_failures() -> None:
    benchmark = json.loads(
        (ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json").read_text(
            encoding="utf-8"
        )
    )
    broken_benchmark = {
        **benchmark,
        "benchmark_id": "tool-selection-core-bad-calibration",
        "version": "1.0.9",
        "judge_path": "evals/results/.tmp-bad-judge-config.json",
    }
    bad_judge_config = RESULTS_ROOT / ".tmp-bad-judge-config.json"
    temp_benchmark_path = RESULTS_ROOT / ".tmp-bad-calibration.benchmark-card.json"
    write_json(
        bad_judge_config,
        {
            "judge_id": "router",
            "judge_version": "v1",
            "rubric_version": "v1",
            "calibration_cases": [],
        },
    )
    write_json(temp_benchmark_path, broken_benchmark)

    try:
        with tempfile.TemporaryDirectory(
            dir=RESULTS_ROOT, prefix="run-benchmark-bad-calibration-"
        ) as tmp:
            output_dir = pathlib.Path(tmp) / "dev"
            # B603 rationale: fixed interpreter and repository test entrypoint.
            # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
            completed = subprocess.run(  # nosec B603
                [
                    sys.executable,
                    str(ROOT / "evals/scripts/run_benchmark.py"),
                    "--benchmark-card",
                    str(temp_benchmark_path),
                    "--split",
                    "dev",
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

            assert completed.returncode != 0
            assert "non-empty calibration_cases" in (completed.stderr or completed.stdout)
    finally:
        temp_benchmark_path.unlink(missing_ok=True)
        bad_judge_config.unlink(missing_ok=True)


def test_judge_task_rejects_semantically_invalid_json_artifact() -> None:
    run_benchmark = load_module("evals_run_benchmark", "evals/scripts/run_benchmark.py")

    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="judge-task-artifact-") as tmp:
        output_dir = pathlib.Path(tmp)
        artifact_path = output_dir / "bad-artifact.json"
        artifact_path.write_text("[]\n", encoding="utf-8")

        judgment = run_benchmark.judge_task(
            {"expected_runtime": "tool"},
            "expected-run",
            "tool",
            {
                "returncode": 0,
                "stdout": "",
                "stderr": "",
                "duration_seconds": 0.0,
            },
            [repo_rel(artifact_path)],
            True,
        )

        assert judgment["verdict"] == "fail"
        assert judgment["artifacts_ok"] is False
        assert "artifact_missing" in judgment["failure_classes"]
