from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
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


def require_command_path(name: str) -> str:
    path = shutil.which(name)
    assert path, f"required command missing for test: {name}"
    return path


def install_command_shims(
    bin_dir: pathlib.Path, *, exclude: set[str] | None = None
) -> None:
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


def install_path_mirror(
    bin_dir: pathlib.Path, *, exclude: set[str] | None = None
) -> None:
    exclude = exclude or set()
    seen: set[str] = set()
    for dir_path in os.environ.get("PATH", "").split(os.pathsep):
        if not dir_path:
            continue
        path_dir = pathlib.Path(dir_path)
        if not path_dir.is_dir():
            continue
        for candidate in path_dir.iterdir():
            try:
                is_file = candidate.is_file()
                executable = os.access(candidate, os.X_OK)
            except PermissionError:
                continue
            if not is_file or not executable:
                continue
            name = candidate.name
            if name in exclude or name in seen:
                continue
            seen.add(name)
            os.symlink(candidate, bin_dir / name)


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

    write_json(
        result_path,
        {
            "run_id": run_id,
            "benchmark_id": benchmark_id,
            "benchmark_version": benchmark_version,
            "split": split,
            "task_count": 1,
            "pass_count": 1,
            "fail_count": 0,
            "aggregate_metrics": {
                "success_rate": 1.0,
                "route_accuracy": 1.0,
                "artifact_completeness": 1.0,
                "checkpoint_compliance": 1.0,
            },
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
    if calibration_payload is not None:
        write_json(calibration_path, calibration_payload)
    ledger_path.write_text(
        json.dumps(
            {
                "entry_id": f"{run_id}-aggregate",
                "kind": "benchmark-run",
                "timestamp": "2026-04-15T00:00:00Z",
                "benchmark_id": benchmark_id,
                "run_id": run_id,
                "split": split,
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
    run_card = {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark_id,
        "benchmark_version": benchmark_version,
        "date": "2026-04-15",
        "split": split,
        "system": {
            "model": "rule-based-router-v1",
            "runtime": "umbrella-benchmark-runner",
        },
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
    if release_gate_status is not None:
        run_card["release_gate_status"] = release_gate_status
        gate_report_path = (
            output_dir / f"release-gate-{benchmark_id}-{split}-{run_id}.json"
        )
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
