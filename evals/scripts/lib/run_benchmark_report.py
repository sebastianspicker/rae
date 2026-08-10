"""Aggregate benchmark task results and write release-gate evidence artifacts."""

import argparse
import pathlib
import re
import sys
from dataclasses import dataclass
from typing import Any

from common import (
    RESULTS_ROOT,
    ROOT,
    dump_json,
    is_within_directory,
    iso_timestamp,
    load_json,
    new_run_id,
    repo_relpath,
    run_command,
)

from lib.run_benchmark_artifacts import (
    BenchmarkArtifacts,
    BenchmarkRun,
    _finish_release_gate,
    _write_run_artifacts,
    aggregate_results,
)
from lib.run_benchmark_evidence import (
    load_optional_json_artifact,
    validate_artifact_id,
)
from lib.run_benchmark_exec import execute_task

REPO_RELATIVE_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


@dataclass(frozen=True)
class BenchmarkExecutionRequest:
    """Inputs required to execute one benchmark split."""

    benchmark: dict[str, Any]
    tasks: list[dict[str, Any]]
    split: str
    output_dir: pathlib.Path
    checkpoint_mode: str


def resolve_repo_child_path(path_str: Any, base: pathlib.Path, label: str) -> pathlib.Path:
    """Reject paths that could make a benchmark read or write outside its allowed root."""
    if not isinstance(path_str, str) or not path_str:
        raise SystemExit(f"{label} must be a non-empty repository-relative path")
    if not REPO_RELATIVE_PATH_RE.fullmatch(path_str):
        raise SystemExit(f"{label} contains unsupported characters")
    candidate = pathlib.Path(path_str)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise SystemExit(f"{label} must not be absolute or contain parent traversal")
    resolved = (ROOT / candidate).resolve(strict=False)
    if not is_within_directory(resolved, base):
        raise SystemExit(f"{label} must point under {repo_relpath(base)}")
    return resolved


def _validate_benchmark_identity(benchmark: dict[str, Any]) -> None:
    try:
        validate_artifact_id(benchmark.get("benchmark_id", ""), "benchmark_id")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    for label in ("version", "judge_version", "judge_path", "task_specs_path"):
        if not isinstance(benchmark.get(label), str) or not benchmark[label]:
            raise SystemExit(f"benchmark {label} must be a non-empty string")


def _validate_task_entries(task_bundle: dict[str, Any]) -> None:
    tasks = task_bundle.get("tasks")
    if not isinstance(tasks, list):
        raise SystemExit("task bundle tasks must be an array")
    for task in tasks:
        if not isinstance(task, dict):
            raise SystemExit("task bundle tasks must be objects")
        try:
            validate_artifact_id(task.get("task_id", ""), "task_id")
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc


def validate_benchmark_inputs(benchmark: dict[str, Any], task_bundle: dict[str, Any]) -> None:
    """Validate benchmark references before executing tools or creating result artifacts."""
    _validate_benchmark_identity(benchmark)
    resolve_repo_child_path(
        benchmark["task_specs_path"], ROOT / "evals/datasets", "task_specs_path"
    )
    resolve_repo_child_path(benchmark["judge_path"], ROOT, "judge_path")
    _validate_task_entries(task_bundle)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a benchmark split through the umbrella harness."
    )
    parser.add_argument("--benchmark-card", required=True)
    parser.add_argument("--split", required=True, choices=["dev", "held-out", "stress", "ablation"])
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--checkpoint-mode", choices=["auto-approve", "require-approval"], default="auto-approve"
    )
    return parser.parse_args()


def _load_run_context(
    args: argparse.Namespace,
) -> tuple[pathlib.Path, dict[str, Any], list[dict[str, Any]], pathlib.Path]:
    benchmark_card_path = pathlib.Path(args.benchmark_card).resolve()
    benchmark = load_json(benchmark_card_path)
    if not isinstance(benchmark, dict):
        raise SystemExit("benchmark card must be a JSON object")
    tasks_path = resolve_repo_child_path(
        benchmark.get("task_specs_path"), ROOT / "evals/datasets", "task_specs_path"
    )
    task_bundle = load_json(tasks_path)
    if not isinstance(task_bundle, dict):
        raise SystemExit("task bundle must be a JSON object")
    validate_benchmark_inputs(benchmark, task_bundle)
    tasks = [task for task in task_bundle["tasks"] if task["split"] == args.split]
    if not tasks:
        raise SystemExit(f"no tasks found for split {args.split}")
    output_dir = pathlib.Path(args.output_dir).resolve(strict=False)
    if not is_within_directory(output_dir, RESULTS_ROOT):
        raise SystemExit("output-dir must point under evals/results")
    output_dir.mkdir(parents=True, exist_ok=True)
    return benchmark_card_path, benchmark, tasks, output_dir


def _execute_benchmark(request: BenchmarkExecutionRequest) -> BenchmarkRun:
    run_id = new_run_id(f"{request.benchmark['benchmark_id']}-{request.split}")
    task_results = [
        execute_task(
            task,
            request.output_dir,
            run_id,
            request.checkpoint_mode,
            request.benchmark,
        )
        for task in request.tasks
    ]
    aggregate_metrics = aggregate_results(task_results)
    result = {
        "run_id": run_id,
        "benchmark_id": request.benchmark["benchmark_id"],
        "benchmark_version": request.benchmark["version"],
        "split": request.split,
        "executed_at": iso_timestamp(),
        "task_count": len(task_results),
        "pass_count": sum(1 for result in task_results if result["judge"]["verdict"] == "pass"),
        "fail_count": sum(1 for result in task_results if result["judge"]["verdict"] == "fail"),
        "aggregate_metrics": aggregate_metrics,
        "task_results": task_results,
    }
    result_path = request.output_dir / (
        f"result-{request.benchmark['benchmark_id']}-{request.split}-{run_id}.json"
    )
    dump_json(result_path, result)
    return BenchmarkRun(
        benchmark=request.benchmark,
        split=request.split,
        run_id=run_id,
        task_results=task_results,
        metrics=aggregate_metrics,
        result_path=result_path,
        output_dir=request.output_dir,
    )


def _run_calibration(run: BenchmarkRun) -> tuple[pathlib.Path, dict[str, Any]]:
    calibration_path = run.output_dir / (
        f"judge-calibration-{run.benchmark['benchmark_id']}-{run.run_id}.json"
    )
    result = run_command(
        [
            sys.executable,
            str(ROOT / "evals/scripts/judge_calibration.py"),
            "--judge-config",
            str(ROOT / run.benchmark["judge_path"]),
            "--output",
            str(calibration_path),
        ]
    )
    return calibration_path, result


def _run_release_gate(
    benchmark_card_path: pathlib.Path,
    artifacts: BenchmarkArtifacts,
    output_path: pathlib.Path,
) -> dict[str, Any]:
    return run_command(
        [
            sys.executable,
            str(ROOT / "evals/scripts/release_gate.py"),
            "--benchmark-card",
            str(benchmark_card_path),
            "--run-card",
            str(artifacts.run_card_path),
            "--regression-report",
            str(artifacts.regression_path),
            "--ledger",
            str(artifacts.ledger_path),
            "--output",
            str(output_path),
        ]
    )


def _report_child_failure(
    result: dict[str, Any],
    *,
    fallback: str,
    report_path: pathlib.Path | None = None,
) -> int:
    message = result["stderr"].strip() or result["stdout"].strip()
    if not message:
        message = _failure_report_message(report_path)
    print(message or fallback, file=sys.stderr)
    return result["returncode"] or 1


def _failure_report_message(report_path: pathlib.Path | None) -> str:
    if report_path is None or not report_path.exists():
        return ""
    report = load_optional_json_artifact(repo_relpath(report_path)) or {}
    issues = report.get("issues")
    if not isinstance(issues, list) or not issues:
        return ""
    return "\n".join(str(issue) for issue in issues)


def main() -> int:
    args = _parse_args()
    benchmark_path, benchmark, tasks, output_dir = _load_run_context(args)
    run = _execute_benchmark(
        BenchmarkExecutionRequest(
            benchmark=benchmark,
            tasks=tasks,
            split=args.split,
            output_dir=output_dir,
            checkpoint_mode=args.checkpoint_mode,
        )
    )
    calibration_path, calibration_result = _run_calibration(run)
    if calibration_result["returncode"] != 0 or not calibration_path.exists():
        return _report_child_failure(calibration_result, fallback="judge calibration failed")
    artifacts = _write_run_artifacts(
        run,
        calibration_path,
        resolve_repo_child_path=resolve_repo_child_path,
    )
    return _finish_release_gate(
        benchmark_path,
        run,
        artifacts,
        run_release_gate=_run_release_gate,
        failure_report_message=_failure_report_message,
        report_child_failure=_report_child_failure,
    )


if __name__ == "__main__":
    raise SystemExit(main())
