"""Aggregate benchmark task results and write release-gate evidence artifacts."""

import argparse
import pathlib
import re
import sys
from typing import Any

from common import (
    RESULTS_ROOT,
    ROOT,
    append_jsonl,
    default_system_metadata,
    dump_json,
    is_within_directory,
    iso_timestamp,
    load_json,
    metric_ratio,
    new_run_id,
    repo_relpath,
    run_command,
    today_iso,
)
from router import ROUTER_VERSION

from lib.run_benchmark_evidence import (
    aggregate_verification_evidence,
    load_optional_json_artifact,
    validate_artifact_id,
)
from lib.run_benchmark_exec import execute_task

REPO_RELATIVE_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


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


def _count_passes(task_results: list[dict[str, Any]]) -> int:
    return sum(1 for result in task_results if result["judge"]["verdict"] == "pass")


def _count_judge_successes(task_results: list[dict[str, Any]], field: str) -> int:
    return sum(1 for result in task_results if result["judge"][field])


def _count_checkpoint_tasks(task_results: list[dict[str, Any]]) -> int:
    return sum(1 for result in task_results if result["checkpoint_paths"])


def _count_approved_checkpoint_tasks(
    task_results: list[dict[str, Any]],
) -> int:
    return sum(
        1
        for result in task_results
        if result["checkpoint_paths"] and result["judge"]["checkpoint_ok"]
    )


def aggregate_results(task_results: list[dict[str, Any]]) -> dict[str, float]:
    total = len(task_results)
    return {
        "success_rate": metric_ratio(_count_passes(task_results), total),
        "route_accuracy": metric_ratio(_count_judge_successes(task_results, "route_ok"), total),
        "artifact_completeness": metric_ratio(
            _count_judge_successes(task_results, "artifacts_ok"), total
        ),
        "checkpoint_compliance": metric_ratio(
            _count_approved_checkpoint_tasks(task_results),
            _count_checkpoint_tasks(task_results),
        ),
    }


def _regression_issues(
    metrics: dict[str, float],
    baseline_metrics: dict[str, Any],
    minimum_metrics: dict[str, Any],
    max_negative_delta: float,
) -> list[str]:
    issues: list[str] = []
    for metric, value in metrics.items():
        baseline_value = float(baseline_metrics.get(metric, value))
        if value + max_negative_delta < baseline_value:
            issues.append(f"{metric} regressed below baseline")
        if metric in minimum_metrics and value < float(minimum_metrics[metric]):
            issues.append(f"{metric} below minimum")
    return issues


def write_regression_report(
    benchmark: dict[str, Any],
    split: str,
    aggregate_metrics: dict[str, float],
    output_dir: pathlib.Path,
    run_id: str,
) -> pathlib.Path:
    regression_policy = benchmark.get("regression_policy", {})
    baselines = regression_policy.get("baseline_results", {})
    baseline_value = baselines.get(split, "")
    baseline_path = (
        resolve_repo_child_path(baseline_value, RESULTS_ROOT, "baseline result path")
        if baseline_value
        else None
    )
    if baseline_path is not None and baseline_path.exists():
        baseline = load_json(baseline_path)
        baseline_metrics = baseline.get("aggregate_metrics", {})
    else:
        baseline = {}
        baseline_metrics = {}
    max_negative_delta = float(regression_policy.get("max_negative_delta", 0.0))
    minimum_metrics = regression_policy.get("minimum_metrics", {})
    regressions = _regression_issues(
        aggregate_metrics, baseline_metrics, minimum_metrics, max_negative_delta
    )

    report = {
        "report_id": f"regression-{run_id}",
        "benchmark_id": benchmark["benchmark_id"],
        "split": split,
        "generated_at": iso_timestamp(),
        "status": "pass" if not regressions else "fail",
        "baseline_result_path": repo_relpath(baseline_path)
        if baseline_path is not None and baseline_path.exists()
        else "",
        "aggregate_metrics": aggregate_metrics,
        "baseline_metrics": baseline_metrics,
        "issues": regressions,
    }
    output_path = output_dir / f"regression-{benchmark['benchmark_id']}-{split}-{run_id}.json"
    dump_json(output_path, report)
    return output_path


def write_result_ledger(
    benchmark: dict[str, Any],
    run_id: str,
    split: str,
    task_results: list[dict[str, Any]],
    aggregate_metrics: dict[str, float],
    result_path: pathlib.Path,
    ledger_path: pathlib.Path,
) -> None:
    aggregate_entry = {
        "entry_id": f"{run_id}-aggregate",
        "kind": "benchmark-run",
        "timestamp": iso_timestamp(),
        "benchmark_id": benchmark["benchmark_id"],
        "run_id": run_id,
        "split": split,
        "result_path": repo_relpath(result_path),
        "claim_links": benchmark.get("claim_links", []),
        "aggregate_metrics": aggregate_metrics,
    }
    append_jsonl(ledger_path, aggregate_entry)
    for result in task_results:
        append_jsonl(
            ledger_path,
            {
                "entry_id": f"{run_id}-{result['task_id']}",
                "kind": "task-result",
                "timestamp": iso_timestamp(),
                "benchmark_id": benchmark["benchmark_id"],
                "run_id": run_id,
                "task_id": result["task_id"],
                "split": result["split"],
                "routed_runtime": result["routed_runtime"],
                "trace_paths": result["trace_paths"],
                "artifact_paths": result["artifact_paths"],
                "checkpoint_paths": result["checkpoint_paths"],
                "claim_links": result["claim_links"],
                "judge_verdict": result["judge"]["verdict"],
            },
        )


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


def _execute_benchmark(
    benchmark: dict[str, Any],
    tasks: list[dict[str, Any]],
    split: str,
    output_dir: pathlib.Path,
    checkpoint_mode: str,
) -> tuple[str, list[dict[str, Any]], dict[str, float], pathlib.Path]:
    run_id = new_run_id(f"{benchmark['benchmark_id']}-{split}")
    task_results = [
        execute_task(task, output_dir, run_id, checkpoint_mode, benchmark) for task in tasks
    ]
    aggregate_metrics = aggregate_results(task_results)
    result = {
        "run_id": run_id,
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "split": split,
        "executed_at": iso_timestamp(),
        "task_count": len(task_results),
        "pass_count": sum(1 for result in task_results if result["judge"]["verdict"] == "pass"),
        "fail_count": sum(1 for result in task_results if result["judge"]["verdict"] == "fail"),
        "aggregate_metrics": aggregate_metrics,
        "task_results": task_results,
    }
    result_path = output_dir / f"result-{benchmark['benchmark_id']}-{split}-{run_id}.json"
    dump_json(result_path, result)
    return run_id, task_results, aggregate_metrics, result_path


def _run_calibration(
    benchmark: dict[str, Any], output_dir: pathlib.Path, run_id: str
) -> tuple[pathlib.Path, dict[str, Any]]:
    calibration_path = output_dir / f"judge-calibration-{benchmark['benchmark_id']}-{run_id}.json"
    result = run_command(
        [
            sys.executable,
            str(ROOT / "evals/scripts/judge_calibration.py"),
            "--judge-config",
            str(ROOT / benchmark["judge_path"]),
            "--output",
            str(calibration_path),
        ]
    )
    return calibration_path, result


def _unique_result_paths(task_results: list[dict[str, Any]], field: str) -> list[str]:
    paths: set[str] = set()
    for result in task_results:
        paths.update(result[field])
    return sorted(paths)


def _all_result_paths(task_results: list[dict[str, Any]], field: str) -> list[str]:
    paths: list[str] = []
    for result in task_results:
        paths.extend(result[field])
    return paths


def _all_tasks_passed(task_results: list[dict[str, Any]]) -> bool:
    return all(result["judge"]["verdict"] == "pass" for result in task_results)


def _run_card_aggregate_fields(
    task_results: list[dict[str, Any]],
) -> dict[str, Any]:
    duration = round(
        sum(result["command_result"]["duration_seconds"] for result in task_results), 4
    )
    return {
        "status": "pass" if _all_tasks_passed(task_results) else "fail",
        "trace_paths": _unique_result_paths(task_results, "trace_paths"),
        "artifact_paths": _unique_result_paths(task_results, "artifact_paths"),
        "checkpoint_paths": _all_result_paths(task_results, "checkpoint_paths"),
        "latency_seconds": duration,
    }


def _build_run_card(
    benchmark: dict[str, Any],
    split: str,
    task_results: list[dict[str, Any]],
    run_id: str,
    result_path: pathlib.Path,
    ledger_path: pathlib.Path,
    regression_path: pathlib.Path,
    calibration_path: pathlib.Path,
) -> dict[str, Any]:
    aggregate_fields = _run_card_aggregate_fields(task_results)
    return {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "date": today_iso(),
        "split": split,
        "system": default_system_metadata("umbrella-benchmark-runner"),
        "judge_version": benchmark["judge_version"],
        "command": "python3 evals/scripts/run_benchmark.py",
        "result_path": repo_relpath(result_path),
        "status": aggregate_fields["status"],
        "task_spec_path": benchmark["task_specs_path"],
        "routed_runtime": "mixed",
        "router": {"version": ROUTER_VERSION, "decision_mode": "per-task"},
        "trace_paths": aggregate_fields["trace_paths"],
        "artifact_paths": aggregate_fields["artifact_paths"],
        "checkpoint_paths": aggregate_fields["checkpoint_paths"],
        "verification_evidence": aggregate_verification_evidence(task_results),
        "claim_links": benchmark.get("claim_links", []),
        "ledger_path": repo_relpath(ledger_path),
        "regression_report_path": repo_relpath(regression_path),
        "judge_calibration_report_path": repo_relpath(calibration_path),
        "cost_usd": 0.0,
        "latency_seconds": aggregate_fields["latency_seconds"],
        "notes": f"Executed {len(task_results)} task(s) for split {split}.",
    }


def _run_release_gate(
    benchmark_card_path: pathlib.Path,
    run_card_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
    output_path: pathlib.Path,
) -> dict[str, Any]:
    return run_command(
        [
            sys.executable,
            str(ROOT / "evals/scripts/release_gate.py"),
            "--benchmark-card",
            str(benchmark_card_path),
            "--run-card",
            str(run_card_path),
            "--regression-report",
            str(regression_path),
            "--ledger",
            str(ledger_path),
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


def _write_run_artifacts(
    benchmark: dict[str, Any],
    split: str,
    task_results: list[dict[str, Any]],
    run_id: str,
    metrics: dict[str, float],
    result_path: pathlib.Path,
    output_dir: pathlib.Path,
    calibration_path: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    regression_path = write_regression_report(benchmark, split, metrics, output_dir, run_id)
    ledger_path = output_dir / "result-ledger.jsonl"
    write_result_ledger(benchmark, run_id, split, task_results, metrics, result_path, ledger_path)
    run_card = _build_run_card(
        benchmark,
        split,
        task_results,
        run_id,
        result_path,
        ledger_path,
        regression_path,
        calibration_path,
    )
    run_card_path = output_dir / f"run-card-{benchmark['benchmark_id']}-{split}-{run_id}.json"
    dump_json(run_card_path, run_card)
    return run_card_path, regression_path, ledger_path


def _finish_release_gate(
    benchmark_path: pathlib.Path,
    benchmark: dict[str, Any],
    split: str,
    run_id: str,
    output_dir: pathlib.Path,
    run_card_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
) -> int:
    output = output_dir / f"release-gate-{benchmark['benchmark_id']}-{split}-{run_id}.json"
    result = _run_release_gate(benchmark_path, run_card_path, regression_path, ledger_path, output)
    if result["returncode"] != 0:
        report_message = _failure_report_message(output)
        if report_message:
            print(report_message, file=sys.stderr)
            return result["returncode"]
        return _report_child_failure(result, fallback="release gate failed", report_path=output)
    print(repo_relpath(run_card_path))
    return 0


def main() -> int:
    args = _parse_args()
    benchmark_path, benchmark, tasks, output_dir = _load_run_context(args)
    run_id, task_results, metrics, result_path = _execute_benchmark(
        benchmark, tasks, args.split, output_dir, args.checkpoint_mode
    )
    calibration_path, calibration_result = _run_calibration(benchmark, output_dir, run_id)
    if calibration_result["returncode"] != 0 or not calibration_path.exists():
        return _report_child_failure(calibration_result, fallback="judge calibration failed")
    run_card_path, regression_path, ledger_path = _write_run_artifacts(
        benchmark,
        args.split,
        task_results,
        run_id,
        metrics,
        result_path,
        output_dir,
        calibration_path,
    )
    return _finish_release_gate(
        benchmark_path,
        benchmark,
        args.split,
        run_id,
        output_dir,
        run_card_path,
        regression_path,
        ledger_path,
    )


if __name__ == "__main__":
    raise SystemExit(main())
