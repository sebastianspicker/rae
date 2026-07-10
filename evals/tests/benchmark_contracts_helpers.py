from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess  # nosec B404
import sys

# B404 rationale: this test helper uses trusted executables and repository-confined argv.

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


def require_command_path(name: str) -> str:
    path = shutil.which(name)
    assert path, f"required command missing for test: {name}"
    return path


def install_command_shims(bin_dir: pathlib.Path, *, exclude: set[str] | None = None) -> None:
    exclude = exclude or set()
    for name in (
        "bash",
        "python3",
        "git",
        "rg",
        "node",
        "npm",
        "jq",
        "mkdocs",
        "shellcheck",
    ):
        if name in exclude:
            continue
        os.symlink(require_command_path(name), bin_dir / name)


def executable_path_candidates() -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    for dir_path in os.environ.get("PATH", "").split(os.pathsep):
        path_dir = pathlib.Path(dir_path)
        if dir_path and path_dir.is_dir():
            candidates.extend(path_dir.iterdir())
    return candidates


def is_executable_file(candidate: pathlib.Path) -> bool:
    try:
        return candidate.is_file() and os.access(candidate, os.X_OK)
    except PermissionError:
        return False


def install_path_mirror(bin_dir: pathlib.Path, *, exclude: set[str] | None = None) -> None:
    excluded = exclude or set()
    seen: set[str] = set()
    for candidate in executable_path_candidates():
        name = candidate.name
        if is_executable_file(candidate) and name not in excluded and name not in seen:
            seen.add(name)
            os.symlink(candidate, bin_dir / name)


def run_python_script(relative_path: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    script_path = (ROOT / relative_path).resolve()
    script_path.relative_to(ROOT.resolve())
    # B603 rationale: fixed interpreter and repository-confined test entrypoint.
    # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit  # noqa: E501
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


def write_result_and_regression_fixtures(
    output_dir: pathlib.Path, benchmark_id: str, benchmark_version: str, split: str, run_id: str
) -> tuple[pathlib.Path, pathlib.Path]:
    result_path = output_dir / f"result-{benchmark_id}-{split}-{run_id}.json"
    regression_path = output_dir / f"regression-{benchmark_id}-{split}-{run_id}.json"
    metrics = release_gate_metrics()
    completed_task_count = 1
    write_json(
        result_path,
        {
            "run_id": run_id,
            "benchmark_id": benchmark_id,
            "benchmark_version": benchmark_version,
            "split": split,
            "task_count": 1,
            "pass_count": completed_task_count,
            "fail_count": 0,
            "aggregate_metrics": metrics,
            "task_results": [],
        },
    )
    write_json(
        regression_path,
        {
            "report_id": f"regression-{benchmark_id}-{split}-{run_id}",
            "benchmark_id": benchmark_id,
            "split": split,
            "generated_at": "2026-04-15T00:00:00Z",
            "status": "pass",
            "baseline_result_path": f"evals/results/baselines/{benchmark_id}-{split}.json",
            "aggregate_metrics": metrics,
            "baseline_metrics": metrics,
            "issues": [],
        },
    )
    return result_path, regression_path


def write_ledger_fixture(
    ledger_path: pathlib.Path, benchmark: dict, result_path: pathlib.Path, split: str, run_id: str
) -> None:
    ledger_path.write_text(
        json.dumps(
            {
                "entry_id": f"{run_id}-aggregate",
                "kind": "benchmark-run",
                "timestamp": "2026-04-15T00:00:00Z",
                "benchmark_id": benchmark["benchmark_id"],
                "run_id": run_id,
                "split": split,
                "result_path": repo_rel(result_path),
                "claim_links": benchmark["claim_links"],
                "aggregate_metrics": release_gate_metrics(),
            }
        )
        + "\n",
        encoding="utf-8",
    )


def release_gate_run_card(
    benchmark: dict,
    result_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
    calibration_path: pathlib.Path,
    split: str,
    run_id: str,
) -> dict:
    return {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "date": "2026-04-15",
        "split": split,
        "system": {"model": "rule-based-router-v1", "runtime": "umbrella-benchmark-runner"},
        "judge_version": "programmatic-router-judge-v1",
        "command": "python3 evals/scripts/run_benchmark.py",
        "result_path": repo_rel(result_path),
        "status": "pass",
        "task_spec_path": benchmark["task_specs_path"],
        "routed_runtime": "mixed",
        "trace_paths": [],
        "artifact_paths": [],
        "checkpoint_paths": [],
        "claim_links": benchmark["claim_links"],
        "ledger_path": repo_rel(ledger_path),
        "regression_report_path": repo_rel(regression_path),
        "judge_calibration_report_path": repo_rel(calibration_path),
        "cost_usd": 0.0,
        "latency_seconds": 0.1,
        "notes": "test fixture",
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
    ledger_path = output_dir / "result-ledger.jsonl"
    calibration_path = output_dir / f"judge-calibration-{benchmark_id}-{run_id}.json"
    run_card_path = output_dir / f"run-card-{benchmark_id}-{split}-{run_id}.json"
    result_path, regression_path = write_result_and_regression_fixtures(
        output_dir, benchmark_id, benchmark["version"], split, run_id
    )
    if calibration_payload is not None:
        write_json(calibration_path, calibration_payload)
    write_ledger_fixture(ledger_path, benchmark, result_path, split, run_id)
    run_card = release_gate_run_card(
        benchmark, result_path, regression_path, ledger_path, calibration_path, split, run_id
    )
    if release_gate_status is not None:
        run_card["release_gate_status"] = release_gate_status
        gate_report_path = output_dir / f"release-gate-{benchmark_id}-{split}-{run_id}.json"
        write_json(
            gate_report_path,
            {
                "gate_id": f"release-gate-{run_id}",
                "evaluated_at": "2026-04-15T00:00:00Z",
                "benchmark_id": benchmark["benchmark_id"],
                "run_id": run_id,
                "status": release_gate_status,
                "issues": [],
            },
        )
        run_card["release_gate_report_path"] = repo_rel(gate_report_path)
    if verification_evidence is not None:
        run_card["verification_evidence"] = verification_evidence
    write_json(run_card_path, run_card)
    return result_path, regression_path, ledger_path, calibration_path, run_card_path
