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

    _append_report_status_issue(issues, regression_path, "regression report is not pass")

    issues.extend(verification_evidence_issues(run_card, run_card_path))

    _append_checkpoint_issues(issues, benchmark, run_card, run_card_path)
    _append_ledger_run_issue(issues, ledger_path, run_card.get("run_id"))
    _append_gate_report_issues(issues, output_path, run_card.get("run_id"))

    return issues


def _append_report_status_issue(issues: list[str], path: pathlib.Path, message: str) -> None:
    if load_json(path).get("status") != "pass":
        issues.append(message)


def _append_checkpoint_issues(
    issues: list[str], benchmark: dict[str, Any], run_card: dict[str, Any], path: pathlib.Path
) -> None:
    if not benchmark.get("release_gate", {}).get("block_on_pending_checkpoints", True):
        return
    states, checkpoint_issues = validate_checkpoint_statuses(run_card, path)
    issues.extend(checkpoint_issues)
    issues.extend(f"checkpoint not approved: {state}" for state in states if state != "approved")


def _append_ledger_run_issue(issues: list[str], path: pathlib.Path, run_id: object) -> None:
    with path.open("r", encoding="utf-8") as handle:
        entries = [json.loads(line) for line in handle if line.strip()]
    if not any(entry.get("run_id") == run_id for entry in entries):
        issues.append("run_id missing from result ledger")


def _append_gate_report_issues(issues: list[str], path: pathlib.Path, run_id: object) -> None:
    report = load_json(path)
    if report.get("status") != "pass":
        issues.append("release gate report is not pass")
    if report.get("run_id") != run_id:
        issues.append("release gate report run_id mismatch")


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

    _append_required_field_issues(issues, run_card)
    _append_benchmark_match_issues(issues, benchmark, run_card)
    if not _append_readable_regression_issue(issues, regression_path):
        return issues

    issues.extend(verification_evidence_issues(run_card, run_card_path))

    _append_checkpoint_issues(issues, benchmark, run_card, run_card_path)

    try:
        with ledger_path.open("r", encoding="utf-8") as handle:
            ledger_entries = [json.loads(line) for line in handle if line.strip()]
    except Exception:
        issues.append("result ledger could not be read")
        return issues
    if not any(entry.get("run_id") == run_card.get("run_id") for entry in ledger_entries):
        issues.append("run_id missing from result ledger")

    # If a prior gate run is declared on this run-card, the gate report must
    # still be present and consistent.  This catches tampered or stale cards
    # without imposing a circular dependency on fresh (un-gated) run-cards.
    _append_declared_gate_report_issues(issues, run_card)

    return issues


def _append_declared_gate_report_issues(issues: list[str], run_card: dict[str, Any]) -> None:
    if run_card.get("release_gate_status") is None:
        return
    path, path_issues = resolve_declared_results_path(
        run_card, "release_gate_report_path", "release gate report"
    )
    issues.extend(path_issues)
    if path is None:
        return
    try:
        report = load_json(path)
    except Exception:
        issues.append("release gate report could not be read")
        return
    if report.get("run_id") != run_card.get("run_id"):
        issues.append("release gate report run_id mismatch")


REQUIRED_RUN_FIELDS = (
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
)


def _append_required_field_issues(issues: list[str], run_card: dict[str, Any]) -> None:
    issues.extend(
        f"run card missing required field: {field}"
        for field in REQUIRED_RUN_FIELDS
        if run_card.get(field) in (None, "")
    )


def _append_benchmark_match_issues(
    issues: list[str], benchmark: dict[str, Any], run_card: dict[str, Any]
) -> None:
    if run_card.get("benchmark_id") not in (None, benchmark["benchmark_id"]):
        issues.append("run card benchmark_id does not match benchmark card")
    if run_card.get("benchmark_version") not in (None, benchmark["version"]):
        issues.append("run card benchmark_version does not match benchmark card")


def _append_readable_regression_issue(issues: list[str], path: pathlib.Path) -> bool:
    try:
        regression = load_json(path)
    except Exception:
        issues.append("regression report could not be read")
        return False
    if regression.get("status") != "pass":
        issues.append("regression report is not pass")
    return True


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

    _append_required_field_issues(issues, run_card)
    _append_benchmark_match_issues(issues, benchmark, run_card)

    split = run_card.get("split")
    if split is not None and split not in benchmark.get("split_policy", []):
        issues.append(f"run card split not allowed by benchmark card: {split}")

    _append_nonnegative_number_issues(issues, run_card)

    _append_result_contract_issues(issues, benchmark, run_card, run_card_path, split)

    _append_calibration_issues(issues, run_card)

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


def _append_nonnegative_number_issues(issues: list[str], card: dict[str, Any]) -> None:
    for field in ("cost_usd", "latency_seconds"):
        value = card.get(field)
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            issues.append(f"run card has invalid {field}")


def _append_result_contract_issues(
    issues: list[str],
    benchmark: dict[str, Any],
    card: dict[str, Any],
    card_path: pathlib.Path,
    split: object,
) -> None:
    path = _result_contract_path(issues, card, card_path)
    if path is None:
        return
    result = load_json(path)
    if not isinstance(result, dict):
        issues.append("benchmark result must be a JSON object")
        return
    _append_result_identity_issues(issues, result, benchmark, card, split)
    _append_result_content_issues(issues, result)


def _result_contract_path(
    issues: list[str], card: dict[str, Any], card_path: pathlib.Path
) -> pathlib.Path | None:
    result_path = card.get("result_path")
    if not result_path:
        return None
    path = resolve_repo_path(str(result_path))
    if not path_under_results(path):
        issues.append("run card result_path is outside evals/results")
        return None
    if not path_within_run_scope(path, card_path):
        issues.append("run card result_path is outside current run scope")
        return None
    if not path.exists():
        issues.append("benchmark result artifact missing")
        return None
    return path


def _append_result_identity_issues(
    issues: list[str],
    result: dict[str, Any],
    benchmark: dict[str, Any],
    card: dict[str, Any],
    split: object,
) -> None:
    checks = (
        ("run_id", card.get("run_id"), "benchmark result run_id mismatch"),
        ("benchmark_id", benchmark["benchmark_id"], "benchmark result benchmark_id mismatch"),
        ("benchmark_version", benchmark["version"], "benchmark result benchmark_version mismatch"),
        ("split", split, "benchmark result split mismatch"),
    )
    for key, expected, message in checks:
        if result.get(key) != expected:
            issues.append(message)


def _append_result_content_issues(issues: list[str], result: dict[str, Any]) -> None:
    if "fail_count" not in result or "task_count" not in result:
        issues.append("benchmark result missing failure summary")
    elif "aggregate_metrics" not in result:
        issues.append("benchmark result missing aggregate_metrics")


def _append_calibration_issues(issues: list[str], card: dict[str, Any]) -> None:
    ref = card.get("judge_calibration_report_path")
    if not ref:
        return
    path = resolve_repo_path(str(ref))
    if not path_under_results(path):
        issues.append("judge calibration report is outside evals/results")
        return
    if not path.exists():
        issues.append("judge calibration report missing")
        return
    calibration = load_json(path)
    if calibration.get("calibration_case_count", 0) <= 0:
        issues.append("judge calibration report has no calibration cases")
    rate = calibration.get("agreement_rate")
    if not isinstance(rate, (int, float)):
        issues.append("judge calibration report missing agreement_rate")
    elif rate < 1.0:
        issues.append("judge calibration agreement_rate is below required threshold")


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

    issues = _verification_summary_issues(summary)

    provided = evidence.get("provided")
    if not isinstance(provided, list):
        issues.append("verification_evidence.provided missing")
        return issues

    validated_types = _append_provided_evidence_issues(issues, provided, run_card, run_card_path)
    _append_declared_type_issue(issues, summary, validated_types)
    return issues


def _verification_summary_issues(summary: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    status = summary.get("status")
    if status in {"partial", "missing"}:
        issues.append(f"verification evidence incomplete: {status}")
    missing = summary.get("missing_types", [])
    if isinstance(missing, list):
        issues.extend(
            f"missing required verification evidence type: {item}"
            for item in missing
            if isinstance(item, str) and item
        )
    return issues


def _append_provided_evidence_issues(
    issues: list[str], provided: list[object], card: dict[str, Any], path: pathlib.Path
) -> set[str]:
    types: set[str] = set()
    for index, entry in enumerate(provided):
        if not isinstance(entry, dict):
            issues.append(f"verification_evidence.provided[{index}] must be an object")
            continue
        entry_type = entry.get("type")
        if isinstance(entry_type, str) and entry_type:
            types.add(entry_type)
        issues.extend(
            validate_verification_evidence_entry(
                entry, index=index, run_card=card, run_card_path=path
            )
        )
    return types


def _append_declared_type_issue(
    issues: list[str], summary: dict[str, Any], validated: set[str]
) -> None:
    provided = summary.get("provided_types")
    if (
        isinstance(provided, list)
        and {item for item in provided if isinstance(item, str) and item} != validated
    ):
        issues.append("verification evidence provided_types does not match provided entries")


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

    benchmark, run_card_path, run_card, regression_path, regression, ledger_path, output = (
        _load_gate_inputs(args)
    )
    issues = validate_run_card_contract(
        benchmark, run_card, run_card_path, regression_path, ledger_path, output
    )
    claim_links = benchmark.get("claim_links", [])
    required_claim_links = benchmark.get("release_gate", {}).get(
        "required_claim_links", claim_links
    )
    _append_main_issues(
        issues, benchmark, run_card, run_card_path, regression, ledger_path, required_claim_links
    )

    current_run_contract_ok = not issues
    _append_required_split_issues(issues, benchmark, run_card, current_run_contract_ok)
    status = "pass" if not issues else "fail"
    _write_gate_report(
        output,
        benchmark,
        run_card,
        (status, issues, claim_links, required_claim_links, ledger_path, regression_path),
    )
    if path_under_results(run_card_path):
        run_card["release_gate_status"] = status
        run_card["release_gate_report_path"] = repo_relpath(output)
        dump_json(run_card_path, run_card)
    print(repo_relpath(output))
    return 0 if status == "pass" else 1


def _load_gate_inputs(
    args: argparse.Namespace,
) -> tuple[Any, pathlib.Path, Any, pathlib.Path, Any, pathlib.Path, pathlib.Path]:
    benchmark = load_json(pathlib.Path(args.benchmark_card).resolve())
    card_path = pathlib.Path(args.run_card).resolve()
    return (
        benchmark,
        card_path,
        load_json(card_path),
        pathlib.Path(args.regression_report).resolve(),
        load_json(pathlib.Path(args.regression_report).resolve()),
        pathlib.Path(args.ledger).resolve(),
        pathlib.Path(args.output).resolve(),
    )


def _append_main_issues(
    issues: list[str],
    benchmark: dict[str, Any],
    card: dict[str, Any],
    path: pathlib.Path,
    regression: dict[str, Any],
    ledger: pathlib.Path,
    links: list[str],
) -> None:
    issues.extend(f"missing claim link: {link}" for link in links if not path_exists(link))
    if regression.get("status") != "pass":
        issues.append("regression report is not pass")
    issues.extend(verification_evidence_issues(card, path))
    _append_checkpoint_issues(issues, benchmark, card, path)
    if not ledger.exists():
        issues.append("result ledger missing")
        return
    _append_ledger_run_issue(issues, ledger, card["run_id"])


def _append_required_split_issues(
    issues: list[str], benchmark: dict[str, Any], card: dict[str, Any], contract_ok: bool
) -> None:
    required_splits = benchmark.get("release_gate", {}).get("required_splits", [])
    current_split = card.get("split", "")
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
            card,
            contract_ok,
        ):
            issues.append(
                f"missing passing release-gated evidence for required split: {required_split}"
            )


def _write_gate_report(
    output: pathlib.Path,
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    data: tuple[str, list[str], list[str], list[str], pathlib.Path, pathlib.Path],
) -> None:
    status, issues, claim_links, required_claim_links, ledger_path, regression_path = data
    report = {
        "gate_id": f"release-gate-{run_card['run_id']}",
        "evaluated_at": iso_timestamp(),
        "benchmark_id": benchmark["benchmark_id"],
        "run_id": run_card["run_id"],
        "status": status,
        "issues": issues,
        "verification_evidence": run_card.get("verification_evidence", {}).get("summary", {})
        if isinstance(run_card.get("verification_evidence"), dict)
        else {},
        "claim_links": claim_links,
        "required_claim_links": required_claim_links,
        "ledger_path": repo_relpath(ledger_path),
        "regression_report_path": repo_relpath(regression_path),
    }
    dump_json(output, report)


if __name__ == "__main__":
    raise SystemExit(main())
