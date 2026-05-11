from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile

from benchmark_contracts_helpers import RESULTS_ROOT, ROOT, install_path_mirror, write_json, write_release_gate_fixture
def test_run_benchmark_rejects_output_dir_outside_results_root() -> None:
    with tempfile.TemporaryDirectory(prefix="rae-benchmark-outside-") as tmp:
        output_dir = pathlib.Path(tmp)
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/run_benchmark.py"),
                "--benchmark-card",
                str(ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"),
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
    assert "output-dir must point under evals/results" in (
        completed.stderr or completed.stdout
    )


def test_run_benchmark_rejects_unsafe_benchmark_id_before_writing() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    benchmark = {**benchmark, "benchmark_id": "x/../../../outside"}
    temp_benchmark_path = RESULTS_ROOT / ".tmp-unsafe-benchmark-id.json"
    write_json(temp_benchmark_path, benchmark)

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="rae-benchmark-unsafe-benchmark-id-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        completed = subprocess.run(
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

    temp_benchmark_path.unlink(missing_ok=True)
    assert completed.returncode != 0
    assert "benchmark_id must match" in (completed.stderr or completed.stdout)


def test_run_benchmark_rejects_unsafe_task_id_before_writing() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    task_bundle_path = ROOT / "evals/datasets/.tmp-unsafe-task-id.task-specs.json"
    benchmark = {
        **benchmark,
        "benchmark_id": "tmp-unsafe-task-id",
        "task_specs_path": "evals/datasets/.tmp-unsafe-task-id.task-specs.json",
    }
    task_bundle = {
        "benchmark_id": "tmp-unsafe-task-id",
        "version": "1.0.0",
        "tasks": [
            {
                "task_id": "../../outside",
                "split": "dev",
                "expected_runtime": "ralph",
            }
        ],
    }
    temp_benchmark_path = RESULTS_ROOT / ".tmp-unsafe-task-id.benchmark-card.json"
    write_json(task_bundle_path, task_bundle)
    write_json(temp_benchmark_path, benchmark)

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="rae-benchmark-unsafe-task-id-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        completed = subprocess.run(
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

    temp_benchmark_path.unlink(missing_ok=True)
    task_bundle_path.unlink(missing_ok=True)
    assert completed.returncode != 0
    assert "task_id must match" in (completed.stderr or completed.stdout)


def test_run_benchmark_accepts_output_dir_under_results_root() -> None:
    results_root = pathlib.Path(os.path.realpath(RESULTS_ROOT))
    with tempfile.TemporaryDirectory(
        dir=results_root, prefix="rae-benchmark-inside-"
    ) as tmp:
        output_dir = pathlib.Path(tmp) / "dev"
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/run_benchmark.py"),
                "--benchmark-card",
                str(ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"),
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

        assert completed.returncode == 0, completed.stderr or completed.stdout
        assert list(output_dir.glob("run-card-*.json"))


def test_run_benchmark_returns_non_zero_when_release_gate_fails() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    results_root = pathlib.Path(os.path.realpath(RESULTS_ROOT))
    with tempfile.TemporaryDirectory(
        dir=results_root, prefix="rae-benchmark-release-gate-fail-"
    ) as tmp:
        output_dir = pathlib.Path(tmp) / "dev"
        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/run_benchmark.py"),
                "--benchmark-card",
                str(benchmark_path),
                "--split",
                "dev",
                "--output-dir",
                str(output_dir),
                "--checkpoint-mode",
                "require-approval",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "checkpoint not approved" in (completed.stderr or completed.stdout)


def test_rae_doctor_reports_missing_rg_dependency() -> None:
    with tempfile.TemporaryDirectory(prefix="rae-doctor-path-") as tmp:
        bin_dir = pathlib.Path(tmp)
        install_path_mirror(bin_dir)
        completed = subprocess.run(
            ["bash", str(ROOT / "scripts/rae.sh"), "doctor"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "PATH": str(bin_dir)},
        )

    combined = f"{completed.stdout}\n{completed.stderr}"
    assert completed.returncode == 0
    assert "OK     rg" in combined

    with tempfile.TemporaryDirectory(prefix="rae-doctor-no-rg-") as tmp:
        bin_dir = pathlib.Path(tmp)
        install_path_mirror(bin_dir, exclude={"rg"})
        completed = subprocess.run(
            ["bash", str(ROOT / "scripts/rae.sh"), "doctor"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "PATH": str(bin_dir)},
        )

    combined = f"{completed.stdout}\n{completed.stderr}"
    assert completed.returncode != 0
    assert "FAIL   rg" in combined


def test_rae_worktree_help_lists_supervision_commands() -> None:
    completed = subprocess.run(
        ["bash", str(ROOT / "scripts/rae.sh"), "worktree", "help"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "summary --run-id <id>" in completed.stdout
    assert "cleanup <path>" in completed.stdout


def test_release_gate_fails_when_required_split_evidence_is_missing() -> None:
    # The held-out gate is the publication gate: it must verify that the prior
    # required split (dev) was also run.  Held-out is index 1 in required_splits
    # so it checks for index 0 (dev) evidence.  When no dev card exists the gate
    # must fail.
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    benchmark = {
        **benchmark,
        "benchmark_id": "tool-selection-core-missing-split",
        "version": "1.0.1",
    }
    temp_benchmark_path = (
        RESULTS_ROOT / ".tmp-tool-selection-core-missing-split.benchmark-card.json"
    )
    write_json(temp_benchmark_path, benchmark)

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-required-splits-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        # Only the held-out fixture is created; no dev card exists.
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="held-out",
            run_id="tool-selection-core-missing-split-held-out-required-splits",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
        )
        gate_output_path = (
            output_dir / "release-gate-tool-selection-core-held-out-required-splits.json"
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "evals/scripts/release_gate.py"),
                "--benchmark-card",
                str(temp_benchmark_path),
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
        assert any(
            "required split: dev" in issue for issue in gate_report["issues"]
        )
    temp_benchmark_path.unlink(missing_ok=True)


def test_release_gate_fails_when_calibration_agreement_is_below_threshold() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-calibration-threshold-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-low-calibration",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 0.5,
                "calibration_case_count": 4,
                "status": "fail",
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
        gate_output_path = (
            output_dir / "release-gate-tool-selection-core-dev-low-calibration.json"
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
        assert any("agreement_rate" in issue for issue in gate_report["issues"])
