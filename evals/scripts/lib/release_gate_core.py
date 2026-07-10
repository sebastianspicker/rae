#!/usr/bin/env python3
"""Release gate CLI and core checks."""

from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any

from common import RESULTS_ROOT, dump_json, iso_timestamp, load_json, path_exists, repo_relpath

from lib.release_gate_helpers import (
    path_under_results,
    path_within_run_scope,
    resolve_declared_results_path,
    resolve_repo_path,
    same_repo_path,
    validate_checkpoint_statuses,
    validate_verification_evidence_entry,
)


def release_gated_evidence_issues(
    benchmark: dict[str, Any], run_card: dict[str, Any], run_card_path: pathlib.Path
) -> list[str]:
    issues: list[str] = []
    regression_path, regression_issues = resolve_declared_results_path(
        run_card, "regression_report_path", "regression report"
    )
    ledger_path, ledger_issues = resolve_declared_results_path(
        run_card, "ledger_path", "result ledger"
    )
    output_path, output_issues = resolve_declared_results_path(
        run_card, "release_gate_report_path", "release gate report"
    )
    issues.extend(regression_issues)
    issues.extend(ledger_issues)
    issues.extend(output_issues)

    if regression_path is None or ledger_path is None or output_path is None:
        return issues

    issues.extend(
        validate_run_card_contract(
            benchmark,
            run_card,
            run_card_path,
            regression_path,
            ledger_path,
            output_path,
        )
    )

    regression = load_json(regression_path)
    if regression.get("status") != "pass":
        issues.append("regression report is not pass")

    issues.extend(verification_evidence_issues(run_card, run_card_path))

    if benchmark.get("release_gate", {}).get("block_on_pending_checkpoints", True):
        checkpoint_states, checkpoint_issues = validate_checkpoint_statuses(
            run_card, run_card_path
        )
        issues.extend(checkpoint_issues)
        for state in checkpoint_states:
            if state != "approved":
                issues.append(f"checkpoint not approved: {state}")

    with ledger_path.open("r", encoding="utf-8") as handle:
        ledger_entries = [json.loads(line) for line in handle if line.strip()]
    if not any(
        entry.get("run_id") == run_card.get("run_id") for entry in ledger_entries
    ):
        issues.append("run_id missing from result ledger")

    gate_report = load_json(output_path)
    if gate_report.get("status") != "pass":
        issues.append("release gate report is not pass")
    if gate_report.get("run_id") != run_card.get("run_id"):
        issues.append("release gate report run_id mismatch")

    return issues


def cross_split_evidence_issues(
    benchmark: dict[str, Any], run_card: dict[str, Any], run_card_path: pathlib.Path
) -> list[str]:
    """Validate a run-card as cross-split evidence for required_splits checks.

    This is a subset of release_gated_evidence_issues that intentionally omits
    the gate report status check.  The full check creates a circular dependency:
    the dev gate requires a passing held-out gate report, which in turn requires
    a passing dev gate report.  This function breaks that cycle by validating
    only the run's own contract — regression pass, ledger registration, required
    fields, and verification evidence — without requiring a prior gate result.
    """
    issues: list[str] = []

    regression_path, regression_issues = resolve_declared_results_path(
        run_card, "regression_report_path", "regression report"
    )
    ledger_path, ledger_issues = resolve_declared_results_path(
        run_card, "ledger_path", "result ledger"
    )
    issues.extend(regression_issues)
    issues.extend(ledger_issues)

    if regression_path is None or ledger_path is None:
        return issues

    required_fields = [
        "benchmark_id",
        "benchmark_version",
        "split",
        "judge_version",
        "command",
        "result_path",
        "judge_calibration_report_path",
        "ledger_path",
        "regression_report_path",
        "cost_usd",
        "latency_seconds",
    ]
    for field in required_fields:
        if run_card.get(field) in (None, ""):
            issues.append(f"run card missing required field: {field}")

    if run_card.get("benchmark_id") not in (None, benchmark["benchmark_id"]):
        issues.append("run card benchmark_id does not match benchmark card")
    if run_card.get("benchmark_version") not in (None, benchmark["version"]):
        issues.append("run card benchmark_version does not match benchmark card")

    try:
        regression = load_json(regression_path)
    except Exception:
        issues.append("regression report could not be read")
        return issues
    if regression.get("status") != "pass":
        issues.append("regression report is not pass")

    issues.extend(verification_evidence_issues(run_card, run_card_path))

    if benchmark.get("release_gate", {}).get("block_on_pending_checkpoints", True):
        checkpoint_states, checkpoint_issues = validate_checkpoint_statuses(
            run_card, run_card_path
        )
        issues.extend(checkpoint_issues)
        for state in checkpoint_states:
            if state != "approved":
                issues.append(f"checkpoint not approved: {state}")

    try:
        with ledger_path.open("r", encoding="utf-8") as handle:
            ledger_entries = [json.loads(line) for line in handle if line.strip()]
    except Exception:
        issues.append("result ledger could not be read")
        return issues
    if not any(
        entry.get("run_id") == run_card.get("run_id") for entry in ledger_entries
    ):
        issues.append("run_id missing from result ledger")

    # If a prior gate run is declared on this run-card, the gate report must
    # still be present and consistent.  This catches tampered or stale cards
    # without imposing a circular dependency on fresh (un-gated) run-cards.
    if run_card.get("release_gate_status") is not None:
        gate_path, gate_path_issues = resolve_declared_results_path(
            run_card, "release_gate_report_path", "release gate report"
        )
        issues.extend(gate_path_issues)
        if gate_path is not None:
            try:
                gate_report = load_json(gate_path)
            except Exception:
                issues.append("release gate report could not be read")
            else:
                if gate_report.get("run_id") != run_card.get("run_id"):
                    issues.append("release gate report run_id mismatch")

    return issues


def discover_release_gated_evidence(
    benchmark: dict[str, Any],
    benchmark_id: str,
    benchmark_version: str,
    required_split: str,
    current_run_card: dict[str, Any],
    current_run_contract_ok: bool,
) -> bool:
    if current_run_card.get("split") == required_split and current_run_contract_ok:
        return True

    for path in RESULTS_ROOT.rglob("run-card-*.json"):
        try:
            candidate = load_json(path)
        except json.JSONDecodeError:
            continue
        if not isinstance(candidate, dict):
            continue
        if candidate.get("evidence_type", "benchmark-run") != "benchmark-run":
            continue
        if candidate.get("benchmark_id") != benchmark_id:
            continue
        if candidate.get("benchmark_version") != benchmark_version:
            continue
        if candidate.get("split") != required_split:
            continue
        if not cross_split_evidence_issues(benchmark, candidate, path):
            return True

    return False


def validate_run_card_contract(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
    output_path: pathlib.Path,
) -> list[str]:
    issues: list[str] = []

    required_fields = [
        "benchmark_id",
        "benchmark_version",
        "split",
        "judge_version",
        "command",
        "result_path",
        "judge_calibration_report_path",
        "ledger_path",
        "regression_report_path",
        "cost_usd",
        "latency_seconds",
    ]
    for field in required_fields:
        value = run_card.get(field)
        if value in (None, ""):
            issues.append(f"run card missing required field: {field}")

    if run_card.get("benchmark_id") not in (None, benchmark["benchmark_id"]):
        issues.append("run card benchmark_id does not match benchmark card")
    if run_card.get("benchmark_version") not in (None, benchmark["version"]):
        issues.append("run card benchmark_version does not match benchmark card")

    split = run_card.get("split")
    if split is not None and split not in benchmark.get("split_policy", []):
        issues.append(f"run card split not allowed by benchmark card: {split}")

    for field in ("cost_usd", "latency_seconds"):
        value = run_card.get(field)
        if value is None:
            continue
        if not isinstance(value, (int, float)) or value < 0:
            issues.append(f"run card has invalid {field}")

    if run_card.get("result_path"):
        result_path = resolve_repo_path(str(run_card["result_path"]))
        if not path_under_results(result_path):
            issues.append("run card result_path is outside evals/results")
        elif not path_within_run_scope(result_path, run_card_path):
            issues.append("run card result_path is outside current run scope")
        elif not result_path.exists():
            issues.append("benchmark result artifact missing")
        else:
            result = load_json(result_path)
            if not isinstance(result, dict):
                issues.append("benchmark result must be a JSON object")
            elif result.get("run_id") != run_card.get("run_id"):
                issues.append("benchmark result run_id mismatch")
            elif result.get("benchmark_id") != benchmark["benchmark_id"]:
                issues.append("benchmark result benchmark_id mismatch")
            elif result.get("benchmark_version") != benchmark["version"]:
                issues.append("benchmark result benchmark_version mismatch")
            elif result.get("split") != split:
                issues.append("benchmark result split mismatch")
            elif "fail_count" not in result or "task_count" not in result:
                issues.append("benchmark result missing failure summary")
            elif "aggregate_metrics" not in result:
                issues.append("benchmark result missing aggregate_metrics")

    calibration_ref = run_card.get("judge_calibration_report_path")
    if calibration_ref:
        calibration_path = resolve_repo_path(str(calibration_ref))
        if not path_under_results(calibration_path):
            issues.append("judge calibration report is outside evals/results")
        elif not calibration_path.exists():
            issues.append("judge calibration report missing")
        else:
            calibration = load_json(calibration_path)
            if calibration.get("calibration_case_count", 0) <= 0:
                issues.append("judge calibration report has no calibration cases")
            agreement_rate = calibration.get("agreement_rate")
            if not isinstance(agreement_rate, (int, float)):
                issues.append("judge calibration report missing agreement_rate")
            elif agreement_rate < 1.0:
                issues.append(
                    "judge calibration agreement_rate is below required threshold"
                )

    if run_card.get("regression_report_path"):
        declared_regression = resolve_repo_path(str(run_card["regression_report_path"]))
        if not same_repo_path(declared_regression, regression_path):
            issues.append(
                "run card regression_report_path does not match provided regression report"
            )

    if run_card.get("ledger_path"):
        declared_ledger = resolve_repo_path(str(run_card["ledger_path"]))
        if not same_repo_path(declared_ledger, ledger_path):
            issues.append("run card ledger_path does not match provided result ledger")

    if not path_under_results(run_card_path):
        issues.append("run card path is outside evals/results")
    if not path_under_results(output_path):
        issues.append("release gate report path is outside evals/results")

    return issues


def verification_evidence_issues(
    run_card: dict[str, Any], run_card_path: pathlib.Path
) -> list[str]:
    evidence = run_card.get("verification_evidence")
    if evidence is None:
        return []
    if not isinstance(evidence, dict):
        return ["verification_evidence must be an object when present"]

    summary = evidence.get("summary")
    if not isinstance(summary, dict):
        return ["verification_evidence.summary missing"]

    issues: list[str] = []
    status = summary.get("status")
    if status in {"partial", "missing"}:
        issues.append(f"verification evidence incomplete: {status}")
    missing_types = summary.get("missing_types", [])
    if isinstance(missing_types, list):
        for evidence_type in missing_types:
            if isinstance(evidence_type, str) and evidence_type:
                issues.append(
                    f"missing required verification evidence type: {evidence_type}"
                )

    provided = evidence.get("provided")
    if not isinstance(provided, list):
        issues.append("verification_evidence.provided missing")
        return issues

    validated_types: set[str] = set()
    for index, entry in enumerate(provided):
        if not isinstance(entry, dict):
            issues.append(f"verification_evidence.provided[{index}] must be an object")
            continue
        entry_type = entry.get("type")
        if isinstance(entry_type, str) and entry_type:
            validated_types.add(entry_type)
        issues.extend(
            validate_verification_evidence_entry(
                entry,
                index=index,
                run_card=run_card,
                run_card_path=run_card_path,
            )
        )

    provided_types = summary.get("provided_types")
    if isinstance(provided_types, list):
        declared_types = {
            entry for entry in provided_types if isinstance(entry, str) and entry
        }
        if declared_types != validated_types:
            issues.append(
                "verification evidence provided_types does not match provided entries"
            )
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate release-blocking gates for a benchmark run."
    )
    parser.add_argument("--benchmark-card", required=True)
    parser.add_argument("--run-card", required=True)
    parser.add_argument("--regression-report", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    benchmark = load_json(pathlib.Path(args.benchmark_card).resolve())
    run_card_path = pathlib.Path(args.run_card).resolve()
    run_card = load_json(run_card_path)
    regression_path = pathlib.Path(args.regression_report).resolve()
    regression = load_json(regression_path)
    ledger_path = pathlib.Path(args.ledger).resolve()
    output = pathlib.Path(args.output).resolve()

    issues = validate_run_card_contract(
        benchmark,
        run_card,
        run_card_path,
        regression_path,
        ledger_path,
        output,
    )
    claim_links = benchmark.get("claim_links", [])
    required_claim_links = benchmark.get("release_gate", {}).get(
        "required_claim_links", claim_links
    )
    for claim_link in required_claim_links:
        if not path_exists(claim_link):
            issues.append(f"missing claim link: {claim_link}")

    if regression.get("status") != "pass":
        issues.append("regression report is not pass")

    issues.extend(verification_evidence_issues(run_card, run_card_path))

    checkpoint_states, checkpoint_issues = validate_checkpoint_statuses(
        run_card, run_card_path
    )
    issues.extend(checkpoint_issues)
    if benchmark.get("release_gate", {}).get("block_on_pending_checkpoints", True):
        for state in checkpoint_states:
            if state != "approved":
                issues.append(f"checkpoint not approved: {state}")

    if not ledger_path.exists():
        issues.append("result ledger missing")
        ledger_entries: list[dict[str, Any]] = []
    else:
        with ledger_path.open("r", encoding="utf-8") as handle:
            ledger_entries = [json.loads(line) for line in handle if line.strip()]
        if not any(
            entry.get("run_id") == run_card["run_id"] for entry in ledger_entries
        ):
            issues.append("run_id missing from result ledger")

    current_run_contract_ok = not issues
    required_splits = benchmark.get("release_gate", {}).get("required_splits", [])
    current_split = run_card.get("split", "")
    # Each split validates only the splits that appear before it in the
    # required_splits list.  This ordering rule prevents a bootstrapping
    # deadlock: if every split had to find evidence from every other split,
    # neither could ever pass from a clean state.  The last split in the
    # list (typically held-out) becomes the natural publication gate because
    # it is the one that must prove all prior splits were run and validated.
    current_split_index = (
        required_splits.index(current_split)
        if current_split in required_splits
        else len(required_splits)
    )
    for required_split in required_splits[:current_split_index]:
        if not discover_release_gated_evidence(
            benchmark,
            benchmark["benchmark_id"],
            benchmark["version"],
            required_split,
            run_card,
            current_run_contract_ok,
        ):
            issues.append(
                f"missing passing release-gated evidence for required split: {required_split}"
            )

    status = "pass" if not issues else "fail"
    report = {
        "gate_id": f"release-gate-{run_card['run_id']}",
        "evaluated_at": iso_timestamp(),
        "benchmark_id": benchmark["benchmark_id"],
        "run_id": run_card["run_id"],
        "status": status,
        "issues": issues,
        "verification_evidence": run_card.get("verification_evidence", {}).get(
            "summary", {}
        )
        if isinstance(run_card.get("verification_evidence"), dict)
        else {},
        "claim_links": claim_links,
        "required_claim_links": required_claim_links,
        "ledger_path": repo_relpath(ledger_path),
        "regression_report_path": repo_relpath(regression_path),
    }
    dump_json(output, report)

    if path_under_results(run_card_path):
        run_card["release_gate_status"] = status
        run_card["release_gate_report_path"] = repo_relpath(output)
        dump_json(run_card_path, run_card)

    print(repo_relpath(output))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
