from __future__ import annotations

import argparse
import pathlib
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
)
from lib.run_benchmark_exec import execute_task
def aggregate_results(task_results: list[dict[str, Any]]) -> dict[str, float]:
    total = len(task_results)
    passes = sum(1 for result in task_results if result["judge"]["verdict"] == "pass")
    route_ok = sum(1 for result in task_results if result["judge"]["route_ok"])
    artifacts_ok = sum(1 for result in task_results if result["judge"]["artifacts_ok"])
    checkpoints_required = sum(
        1 for result in task_results if result["checkpoint_paths"]
    )
    checkpoints_ok = sum(
        1
        for result in task_results
        if result["checkpoint_paths"] and result["judge"]["checkpoint_ok"]
    )
    return {
        "success_rate": metric_ratio(passes, total),
        "route_accuracy": metric_ratio(route_ok, total),
        "artifact_completeness": metric_ratio(artifacts_ok, total),
        "checkpoint_compliance": metric_ratio(checkpoints_ok, checkpoints_required),
    }


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
    baseline_path = (ROOT / baseline_value).resolve() if baseline_value else None
    if baseline_path is not None and baseline_path.exists():
        baseline = load_json(baseline_path)
        baseline_metrics = baseline.get("aggregate_metrics", {})
    else:
        baseline = {}
        baseline_metrics = {}
    max_negative_delta = float(regression_policy.get("max_negative_delta", 0.0))
    minimum_metrics = regression_policy.get("minimum_metrics", {})
    regressions: list[str] = []

    for metric, value in aggregate_metrics.items():
        baseline_value = float(baseline_metrics.get(metric, value))
        if value + max_negative_delta < baseline_value:
            regressions.append(f"{metric} regressed below baseline")
        if metric in minimum_metrics and value < float(minimum_metrics[metric]):
            regressions.append(f"{metric} below minimum")

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
    output_path = (
        output_dir / f"regression-{benchmark['benchmark_id']}-{split}-{run_id}.json"
    )
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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a benchmark split through the umbrella harness."
    )
    parser.add_argument("--benchmark-card", required=True)
    parser.add_argument(
        "--split", required=True, choices=["dev", "held-out", "stress", "ablation"]
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--checkpoint-mode",
        choices=["auto-approve", "require-approval"],
        default="auto-approve",
    )
    args = parser.parse_args()

    benchmark_card_path = pathlib.Path(args.benchmark_card).resolve()
    benchmark = load_json(benchmark_card_path)
    tasks_path = (ROOT / benchmark["task_specs_path"]).resolve()
    task_bundle = load_json(tasks_path)
    tasks = [task for task in task_bundle["tasks"] if task["split"] == args.split]
    if not tasks:
        raise SystemExit(f"no tasks found for split {args.split}")

    output_dir = pathlib.Path(args.output_dir).resolve(strict=False)
    if not is_within_directory(output_dir, RESULTS_ROOT):
        raise SystemExit("output-dir must point under evals/results")
    output_dir.mkdir(parents=True, exist_ok=True)
    run_id = new_run_id(f"{benchmark['benchmark_id']}-{args.split}")
    task_results = [
        execute_task(task, output_dir, run_id, args.checkpoint_mode, benchmark)
        for task in tasks
    ]
    aggregate_metrics = aggregate_results(task_results)

    result = {
        "run_id": run_id,
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "split": args.split,
        "executed_at": iso_timestamp(),
        "task_count": len(task_results),
        "pass_count": sum(
            1 for result in task_results if result["judge"]["verdict"] == "pass"
        ),
        "fail_count": sum(
            1 for result in task_results if result["judge"]["verdict"] == "fail"
        ),
        "aggregate_metrics": aggregate_metrics,
        "task_results": task_results,
    }
    result_path = (
        output_dir / f"result-{benchmark['benchmark_id']}-{args.split}-{run_id}.json"
    )
    dump_json(result_path, result)

    calibration_path = (
        output_dir / f"judge-calibration-{benchmark['benchmark_id']}-{run_id}.json"
    )
    calibration_result = run_command(
        [
            "python3",
            str(ROOT / "evals/scripts/judge_calibration.py"),
            "--judge-config",
            str(ROOT / benchmark["judge_path"]),
            "--output",
            str(calibration_path),
        ]
    )
    if calibration_result["returncode"] != 0 or not calibration_path.exists():
        message = (
            calibration_result["stderr"].strip() or calibration_result["stdout"].strip()
        )
        if not message:
            message = "judge calibration failed"
        print(message, file=sys.stderr)
        return calibration_result["returncode"] or 1

    regression_path = write_regression_report(
        benchmark, args.split, aggregate_metrics, output_dir, run_id
    )
    ledger_path = output_dir / "result-ledger.jsonl"
    write_result_ledger(
        benchmark,
        run_id,
        args.split,
        task_results,
        aggregate_metrics,
        result_path,
        ledger_path,
    )

    run_card = {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "date": today_iso(),
        "split": args.split,
        "system": default_system_metadata("umbrella-benchmark-runner"),
        "judge_version": benchmark["judge_version"],
        "command": "python3 evals/scripts/run_benchmark.py",
        "result_path": repo_relpath(result_path),
        "status": "pass" if result["fail_count"] == 0 else "fail",
        "task_spec_path": benchmark["task_specs_path"],
        "routed_runtime": "mixed",
        "router": {
            "version": ROUTER_VERSION,
            "decision_mode": "per-task",
        },
        "trace_paths": sorted(
            {path for result in task_results for path in result["trace_paths"]}
        ),
        "artifact_paths": sorted(
            {path for result in task_results for path in result["artifact_paths"]}
        ),
        "checkpoint_paths": [
            path for result in task_results for path in result["checkpoint_paths"]
        ],
        "verification_evidence": aggregate_verification_evidence(task_results),
        "claim_links": benchmark.get("claim_links", []),
        "ledger_path": repo_relpath(ledger_path),
        "regression_report_path": repo_relpath(regression_path),
        "judge_calibration_report_path": repo_relpath(calibration_path),
        "cost_usd": 0.0,
        "latency_seconds": round(
            sum(
                result["command_result"]["duration_seconds"] for result in task_results
            ),
            4,
        ),
        "notes": f"Executed {len(task_results)} task(s) for split {args.split}.",
    }
    run_card_path = (
        output_dir / f"run-card-{benchmark['benchmark_id']}-{args.split}-{run_id}.json"
    )
    dump_json(run_card_path, run_card)

    release_gate_path = (
        output_dir
        / f"release-gate-{benchmark['benchmark_id']}-{args.split}-{run_id}.json"
    )
    gate_result = run_command(
        [
            "python3",
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
            str(release_gate_path),
        ]
    )
    if gate_result["returncode"] != 0:
        message = gate_result["stderr"].strip()
        if not message and release_gate_path.exists():
            gate_report = (
                load_optional_json_artifact(repo_relpath(release_gate_path)) or {}
            )
            if isinstance(gate_report.get("issues"), list) and gate_report["issues"]:
                message = "\n".join(str(issue) for issue in gate_report["issues"])
        if not message:
            message = gate_result["stdout"] or "release gate failed"
        print(message, file=sys.stderr)
        return gate_result["returncode"]

    print(repo_relpath(run_card_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
