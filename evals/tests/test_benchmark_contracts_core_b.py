from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

from benchmark_contracts_helpers import (
    RESULTS_ROOT,
    ROOT,
    repo_rel,
    write_json,
    write_release_gate_fixture,
)


def test_validate_eval_metadata_discovers_generated_run_card_names() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="validate-generated-run-cards-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, _, _, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-invalid-run-card",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
        )
        invalid_payload = json.loads(run_card_path.read_text(encoding="utf-8"))
        invalid_payload.pop("result_path", None)
        write_json(run_card_path, invalid_payload)

        # B603 rationale: fixed interpreter and repository test entrypoint.
        completed = subprocess.run(  # nosec B603
            [sys.executable, str(ROOT / "evals/scripts/validate_eval_metadata.py")],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        assert completed.returncode != 0
        assert "missing benchmark-run keys: result_path" in (
            completed.stderr or completed.stdout
        )


def test_release_gate_accepts_valid_benchmark_run_contract() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-pass-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-example",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
        )
        write_release_gate_fixture(
            output_dir / "held-out-pass",
            split="held-out",
            run_id="tool-selection-core-held-out-example",
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
            output_dir / "release-gate-tool-selection-core-dev-example.json"
        )

        # B603 rationale: fixed interpreter and repository test entrypoint.
        completed = subprocess.run(  # nosec B603
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

        assert completed.returncode == 0
        gate_report = json.loads(gate_output_path.read_text(encoding="utf-8"))
        assert gate_report["status"] == "pass"
        updated_run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
        assert updated_run_card["release_gate_status"] == "pass"


def test_release_gate_ignores_stale_passing_run_cards_for_required_split() -> None:
    # The held-out gate checks for dev evidence (prior required split).  A dev
    # run-card that declares release_gate_status: pass but is missing its gate
    # report file is stale and must be rejected.
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
    benchmark = {
        **benchmark,
        "benchmark_id": "tool-selection-core-stale-required-split",
        "version": "1.0.2",
    }
    temp_benchmark_path = (
        RESULTS_ROOT
        / ".tmp-tool-selection-core-stale-required-split.benchmark-card.json"
    )
    write_json(temp_benchmark_path, benchmark)

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-stale-required-split-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        # Create the dev fixture then corrupt it by removing its gate report path.
        dev_dir = output_dir / "dev-stale"
        _, _, _, _, dev_run_card_path = write_release_gate_fixture(
            dev_dir,
            split="dev",
            run_id="tool-selection-core-stale-required-split-dev",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
            release_gate_status="pass",
        )
        stale_payload = json.loads(dev_run_card_path.read_text(encoding="utf-8"))
        stale_payload.pop("release_gate_report_path", None)
        write_json(dev_run_card_path, stale_payload)

        # Create the held-out fixture — this is the run being gated.
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="held-out",
            run_id="tool-selection-core-stale-required-split-held-out",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
        )
        gate_output_path = (
            output_dir
            / "release-gate-tool-selection-core-held-out-stale-required-split.json"
        )
        # B603 rationale: fixed interpreter and repository test entrypoint.
        completed = subprocess.run(  # nosec B603
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


def test_release_gate_fails_when_required_verification_evidence_is_missing() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-evidence-missing-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-missing-evidence",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
            verification_evidence={
                "required_types": ["command-log", "trace"],
                "provided": [
                    {
                        "task_id": "tool-selection-dev-orchestration",
                        "type": "command-log",
                        "path": repo_rel(output_dir / "command-results.json"),
                    }
                ],
                "task_statuses": [
                    {
                        "task_id": "tool-selection-dev-orchestration",
                        "status": "partial",
                        "missing_types": ["trace"],
                    }
                ],
                "summary": {
                    "status": "partial",
                    "provided_types": ["command-log"],
                    "missing_types": ["trace"],
                    "residual_gaps": ["missing evidence type: trace"],
                },
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
            output_dir / "release-gate-tool-selection-core-dev-missing-evidence.json"
        )

        # B603 rationale: fixed interpreter and repository test entrypoint.
        completed = subprocess.run(  # nosec B603
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
        assert any(
            "verification evidence incomplete" in issue
            for issue in gate_report["issues"]
        )
        assert any("trace" in issue for issue in gate_report["issues"])


def test_release_gate_rejects_checkpoint_outside_current_run_scope() -> None:
    benchmark_path = ROOT / "evals/benchmarks/tool-selection-core.benchmark-card.json"
    benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(
        dir=RESULTS_ROOT, prefix="release-gate-forged-checkpoint-"
    ) as tmp:
        output_dir = pathlib.Path(tmp)
        _, regression_path, ledger_path, _, run_card_path = write_release_gate_fixture(
            output_dir,
            split="dev",
            run_id="tool-selection-core-dev-forged-checkpoint",
            benchmark=benchmark,
            calibration_payload={
                "judge_id": "router",
                "agreement_rate": 1.0,
                "calibration_case_count": 4,
                "status": "pass",
            },
        )
        forged_dir = output_dir.parent / "forged-checkpoints"
        forged_checkpoint = forged_dir / "forged.checkpoint.json"
        write_json(
            forged_checkpoint,
            {
                "checkpoint_id": "forged",
                "run_id": "tool-selection-core-dev-forged-checkpoint",
                "status": "approved",
            },
        )
        run_card = json.loads(run_card_path.read_text(encoding="utf-8"))
        run_card["checkpoint_paths"] = [repo_rel(forged_checkpoint)]
        write_json(run_card_path, run_card)
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
            output_dir / "release-gate-tool-selection-core-dev-forged-checkpoint.json"
        )

        # B603 rationale: fixed interpreter and repository test entrypoint.
        completed = subprocess.run(  # nosec B603
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
        assert any(
            "checkpoint path outside current run scope" in issue
            for issue in gate_report["issues"]
        )
