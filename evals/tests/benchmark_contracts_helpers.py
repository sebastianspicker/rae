"""Reusable filesystem and subprocess fixtures for benchmark contract tests."""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS_ROOT = ROOT / "evals" / "results"


def load_module(module_name: str, relative_path: str):
    sys.path.insert(0, str((ROOT / relative_path).parent))
    spec = importlib.util.spec_from_file_location(module_name, ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


def write_json(path: pathlib.Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def repo_rel(path: pathlib.Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def calibration_payload(*, agreement_rate: float = 1.0, status: str = "pass") -> dict:
    return {
        "judge_id": "router",
        "agreement_rate": agreement_rate,
        "calibration_case_count": 4,
        "status": status,
    }


def write_passing_held_out_fixture(output_dir: pathlib.Path, benchmark: dict) -> None:
    write_release_gate_fixture(
        output_dir / "held-out-pass",
        split="held-out",
        run_id="tool-selection-core-held-out-pass",
        benchmark=benchmark,
        calibration_payload=calibration_payload(),
        release_gate_status="pass",
    )


def install_path_mirror(bin_dir: pathlib.Path, *, exclude: set[str] | None = None) -> None:
    exclude = exclude or set()
    seen: set[str] = set()
    for dir_path in os.environ.get("PATH", "").split(os.pathsep):
        path_dir = pathlib.Path(dir_path)
        if not path_dir.is_dir():
            continue
        for candidate in path_dir.iterdir():
            _mirror_candidate(candidate, bin_dir, exclude, seen)


def _mirror_candidate(
    candidate: pathlib.Path, bin_dir: pathlib.Path, exclude: set[str], seen: set[str]
) -> None:
    try:
        usable = candidate.is_file() and os.access(candidate, os.X_OK)
    except PermissionError:
        return
    if not usable or candidate.name in exclude or candidate.name in seen:
        return
    seen.add(candidate.name)
    os.symlink(candidate, bin_dir / candidate.name)


def run_python_script(relative_path: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    script_path = (ROOT / relative_path).resolve()
    script_path.relative_to(ROOT.resolve())
    # B603 rationale: fixed interpreter and repository-confined test entrypoint.
    # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.
    # dangerous-subprocess-use-audit
    return subprocess.run(  # nosec B603
        [sys.executable, str(script_path), *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def run_release_gate(
    benchmark_path: pathlib.Path,
    run_card_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
    gate_output_path: pathlib.Path,
) -> subprocess.CompletedProcess[str]:
    return run_python_script(
        "evals/scripts/release_gate.py",
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
    )


def release_gate_metrics() -> dict[str, float]:
    return {
        "success_rate": 1.0,
        "route_accuracy": 1.0,
        "artifact_completeness": 1.0,
        "checkpoint_compliance": 1.0,
    }


def write_release_gate_fixture(
    output_dir: pathlib.Path,
    *,
    split: str,
    run_id: str,
    benchmark: dict,
    calibration_payload: dict | None = None,
    release_gate_status: str | None = None,
    verification_evidence: dict | None = None,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    benchmark_id = benchmark["benchmark_id"]
    benchmark_version = benchmark["version"]
    result_path = output_dir / f"result-{benchmark_id}-{split}-{run_id}.json"
    regression_path = output_dir / f"regression-{benchmark_id}-{split}-{run_id}.json"
    ledger_path = output_dir / "result-ledger.jsonl"
    calibration_path = output_dir / f"judge-calibration-{benchmark_id}-{run_id}.json"
    run_card_path = output_dir / f"run-card-{benchmark_id}-{split}-{run_id}.json"

    _write_result_fixture(result_path, run_id, benchmark_id, benchmark_version, split)
    _write_regression_fixture(regression_path, run_id, benchmark_id, split)
    if calibration_payload is not None:
        write_json(calibration_path, calibration_payload)
    _write_ledger_fixture(ledger_path, run_id, benchmark_id, split, result_path, benchmark)
    paths = {
        "result": result_path,
        "regression": regression_path,
        "ledger": ledger_path,
        "calibration": calibration_path,
    }
    run_card = _run_card_fixture(run_id, benchmark_id, benchmark_version, split, paths, benchmark)
    _add_release_gate_fixture(
        run_card, output_dir, benchmark_id, split, run_id, release_gate_status
    )
    if verification_evidence is not None:
        run_card["verification_evidence"] = verification_evidence
    write_json(run_card_path, run_card)
    return result_path, regression_path, ledger_path, calibration_path, run_card_path


def _metrics() -> dict[str, float]:
    return {
        "success_rate": 1.0,
        "route_accuracy": 1.0,
        "artifact_completeness": 1.0,
        "checkpoint_compliance": 1.0,
    }


def _write_result_fixture(
    path: pathlib.Path, run_id: str, benchmark_id: str, version: str, split: str
) -> None:
    passed_tasks = 1
    write_json(
        path,
        {
            "run_id": run_id,
            "benchmark_id": benchmark_id,
            "benchmark_version": version,
            "split": split,
            "task_count": 1,
            "pass_count": passed_tasks,
            "fail_count": 0,
            "aggregate_metrics": _metrics(),
            "task_results": [],
        },
    )


def _write_regression_fixture(
    path: pathlib.Path, run_id: str, benchmark_id: str, split: str
) -> None:
    write_json(
        path,
        {
            "report_id": f"regression-{benchmark_id}-{split}-{run_id}",
            "benchmark_id": benchmark_id,
            "split": split,
            "generated_at": "2026-04-15T00:00:00Z",
            "status": "pass",
            "baseline_result_path": f"evals/results/baselines/{benchmark_id}-{split}.json",
            "aggregate_metrics": _metrics(),
            "baseline_metrics": _metrics(),
            "issues": [],
        },
    )


def _write_ledger_fixture(
    path: pathlib.Path,
    run_id: str,
    benchmark_id: str,
    split: str,
    result_path: pathlib.Path,
    benchmark: dict,
) -> None:
    entry = {
        "entry_id": f"{run_id}-aggregate",
        "kind": "benchmark-run",
        "timestamp": "2026-04-15T00:00:00Z",
        "benchmark_id": benchmark_id,
        "run_id": run_id,
        "split": split,
        "result_path": repo_rel(result_path),
        "claim_links": benchmark["claim_links"],
        "aggregate_metrics": _metrics(),
    }
    path.write_text(json.dumps(entry) + "\n", encoding="utf-8")


def _run_card_fixture(
    run_id: str,
    benchmark_id: str,
    version: str,
    split: str,
    paths: dict[str, pathlib.Path],
    benchmark: dict,
) -> dict:
    return {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark_id,
        "benchmark_version": version,
        "date": "2026-04-15",
        "split": split,
        "system": {"model": "rule-based-router-v1", "runtime": "umbrella-benchmark-runner"},
        "judge_version": "programmatic-router-judge-v1",
        "command": "python3 evals/scripts/run_benchmark.py",
        "result_path": repo_rel(paths["result"]),
        "status": "pass",
        "task_spec_path": benchmark["task_specs_path"],
        "routed_runtime": "mixed",
        "trace_paths": [],
        "artifact_paths": [],
        "checkpoint_paths": [],
        "claim_links": benchmark["claim_links"],
        "ledger_path": repo_rel(paths["ledger"]),
        "regression_report_path": repo_rel(paths["regression"]),
        "judge_calibration_report_path": repo_rel(paths["calibration"]),
        "cost_usd": 0.0,
        "latency_seconds": 0.1,
        "notes": "test fixture",
    }


def _add_release_gate_fixture(
    run_card: dict,
    output_dir: pathlib.Path,
    benchmark_id: str,
    split: str,
    run_id: str,
    status: str | None,
) -> None:
    if status is not None:
        run_card["release_gate_status"] = status
        gate_report_path = output_dir / f"release-gate-{benchmark_id}-{split}-{run_id}.json"
        write_json(
            gate_report_path,
            {
                "gate_id": f"release-gate-{run_id}",
                "evaluated_at": "2026-04-15T00:00:00Z",
                "benchmark_id": benchmark_id,
                "run_id": run_id,
                "status": status,
                "issues": [],
            },
        )
        run_card["release_gate_report_path"] = repo_rel(gate_report_path)
