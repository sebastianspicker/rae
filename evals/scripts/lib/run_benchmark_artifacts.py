"""Build benchmark evidence artifacts and finish release-gate reporting."""

import pathlib
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from common import (
    RESULTS_ROOT,
    append_jsonl,
    default_system_metadata,
    dump_json,
    iso_timestamp,
    load_json,
    metric_ratio,
    repo_relpath,
    today_iso,
)
from router import ROUTER_VERSION

from lib.run_benchmark_evidence import aggregate_verification_evidence


@dataclass(frozen=True)
class BenchmarkRun:
    """Result data shared by the benchmark evidence-writing stages."""

    benchmark: dict[str, Any]
    split: str
    run_id: str
    task_results: list[dict[str, Any]]
    metrics: dict[str, float]
    result_path: pathlib.Path
    output_dir: pathlib.Path


@dataclass(frozen=True)
class BenchmarkArtifacts:
    """Evidence paths consumed by the final release-gate stage."""

    run_card_path: pathlib.Path
    regression_path: pathlib.Path
    ledger_path: pathlib.Path
    calibration_path: pathlib.Path


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
    """Aggregate task-level benchmark results into release-gate metrics."""
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
    run: BenchmarkRun,
    *,
    resolve_repo_child_path: Callable[[Any, pathlib.Path, str], pathlib.Path],
) -> pathlib.Path:
    """Write the regression comparison for one completed benchmark run."""
    regression_policy = run.benchmark.get("regression_policy", {})
    baselines = regression_policy.get("baseline_results", {})
    baseline_value = baselines.get(run.split, "")
    baseline_path = (
        resolve_repo_child_path(baseline_value, RESULTS_ROOT, "baseline result path")
        if baseline_value
        else None
    )
    if baseline_path is not None and baseline_path.exists():
        baseline = load_json(baseline_path)
        baseline_metrics = baseline.get("aggregate_metrics", {})
    else:
        baseline_metrics = {}
    max_negative_delta = float(regression_policy.get("max_negative_delta", 0.0))
    minimum_metrics = regression_policy.get("minimum_metrics", {})
    regressions = _regression_issues(
        run.metrics, baseline_metrics, minimum_metrics, max_negative_delta
    )

    report = {
        "report_id": f"regression-{run.run_id}",
        "benchmark_id": run.benchmark["benchmark_id"],
        "split": run.split,
        "generated_at": iso_timestamp(),
        "status": "pass" if not regressions else "fail",
        "baseline_result_path": repo_relpath(baseline_path)
        if baseline_path is not None and baseline_path.exists()
        else "",
        "aggregate_metrics": run.metrics,
        "baseline_metrics": baseline_metrics,
        "issues": regressions,
    }
    output_path = run.output_dir / (
        f"regression-{run.benchmark['benchmark_id']}-{run.split}-{run.run_id}.json"
    )
    dump_json(output_path, report)
    return output_path


def write_result_ledger(run: BenchmarkRun, ledger_path: pathlib.Path) -> None:
    """Append aggregate and task-result entries for one benchmark run."""
    aggregate_entry = {
        "entry_id": f"{run.run_id}-aggregate",
        "kind": "benchmark-run",
        "timestamp": iso_timestamp(),
        "benchmark_id": run.benchmark["benchmark_id"],
        "run_id": run.run_id,
        "split": run.split,
        "result_path": repo_relpath(run.result_path),
        "claim_links": run.benchmark.get("claim_links", []),
        "aggregate_metrics": run.metrics,
    }
    append_jsonl(ledger_path, aggregate_entry)
    for result in run.task_results:
        append_jsonl(
            ledger_path,
            {
                "entry_id": f"{run.run_id}-{result['task_id']}",
                "kind": "task-result",
                "timestamp": iso_timestamp(),
                "benchmark_id": run.benchmark["benchmark_id"],
                "run_id": run.run_id,
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


def _build_run_card(run: BenchmarkRun, artifacts: BenchmarkArtifacts) -> dict[str, Any]:
    aggregate_fields = _run_card_aggregate_fields(run.task_results)
    return {
        "run_id": run.run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": run.benchmark["benchmark_id"],
        "benchmark_version": run.benchmark["version"],
        "date": today_iso(),
        "split": run.split,
        "system": default_system_metadata("umbrella-benchmark-runner"),
        "judge_version": run.benchmark["judge_version"],
        "command": "python3 evals/scripts/run_benchmark.py",
        "result_path": repo_relpath(run.result_path),
        "status": aggregate_fields["status"],
        "task_spec_path": run.benchmark["task_specs_path"],
        "routed_runtime": "mixed",
        "router": {"version": ROUTER_VERSION, "decision_mode": "per-task"},
        "trace_paths": aggregate_fields["trace_paths"],
        "artifact_paths": aggregate_fields["artifact_paths"],
        "checkpoint_paths": aggregate_fields["checkpoint_paths"],
        "verification_evidence": aggregate_verification_evidence(run.task_results),
        "claim_links": run.benchmark.get("claim_links", []),
        "ledger_path": repo_relpath(artifacts.ledger_path),
        "regression_report_path": repo_relpath(artifacts.regression_path),
        "judge_calibration_report_path": repo_relpath(artifacts.calibration_path),
        "cost_usd": 0.0,
        "latency_seconds": aggregate_fields["latency_seconds"],
        "notes": f"Executed {len(run.task_results)} task(s) for split {run.split}.",
    }


def _write_run_artifacts(
    run: BenchmarkRun,
    calibration_path: pathlib.Path,
    *,
    resolve_repo_child_path: Callable[[Any, pathlib.Path, str], pathlib.Path],
) -> BenchmarkArtifacts:
    regression_path = write_regression_report(run, resolve_repo_child_path=resolve_repo_child_path)
    ledger_path = run.output_dir / "result-ledger.jsonl"
    write_result_ledger(run, ledger_path)
    run_card_path = run.output_dir / (
        f"run-card-{run.benchmark['benchmark_id']}-{run.split}-{run.run_id}.json"
    )
    artifacts = BenchmarkArtifacts(
        run_card_path=run_card_path,
        regression_path=regression_path,
        ledger_path=ledger_path,
        calibration_path=calibration_path,
    )
    dump_json(run_card_path, _build_run_card(run, artifacts))
    return artifacts


def _finish_release_gate(
    benchmark_path: pathlib.Path,
    run: BenchmarkRun,
    artifacts: BenchmarkArtifacts,
    *,
    run_release_gate: Callable[[pathlib.Path, BenchmarkArtifacts, pathlib.Path], dict[str, Any]],
    failure_report_message: Callable[[pathlib.Path | None], str],
    report_child_failure: Callable[..., int],
) -> int:
    output = run.output_dir / (
        f"release-gate-{run.benchmark['benchmark_id']}-{run.split}-{run.run_id}.json"
    )
    result = run_release_gate(benchmark_path, artifacts, output)
    if result["returncode"] != 0:
        report_message = failure_report_message(output)
        if report_message:
            print(report_message, file=sys.stderr)
            return result["returncode"]
        return report_child_failure(result, fallback="release gate failed", report_path=output)
    print(repo_relpath(artifacts.run_card_path))
    return 0
