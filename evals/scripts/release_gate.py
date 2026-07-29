#!/usr/bin/env python3
"""Block publication when regression or evidence gates fail."""

import argparse
import pathlib

from common import dump_json, repo_relpath
from lib.release_gate_core import (
    _build_gate_report,
    _checkpoint_gate_issues,
    _claim_link_issues,
    _ledger_registration_issues,
    _load_object,
    _required_split_issues,
    path_under_results,
    validate_run_card_contract,
    verification_evidence_issues,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate release-blocking gates for a benchmark run."
    )
    parser.add_argument("--benchmark-card", required=True)
    parser.add_argument("--run-card", required=True)
    parser.add_argument("--regression-report", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def _ledger_issues(ledger_path: pathlib.Path, run_id: object) -> list[str]:
    return (
        ["result ledger missing"]
        if not ledger_path.exists()
        else _ledger_registration_issues(ledger_path, run_id)
    )


def main() -> int:
    args = _parse_args()
    benchmark = _load_object(pathlib.Path(args.benchmark_card).resolve())
    run_card_path = pathlib.Path(args.run_card).resolve()
    run_card = _load_object(run_card_path)
    regression_path = pathlib.Path(args.regression_report).resolve()
    regression = _load_object(regression_path)
    ledger_path = pathlib.Path(args.ledger).resolve()
    output = pathlib.Path(args.output).resolve()
    issues = validate_run_card_contract(
        benchmark, run_card, run_card_path, regression_path, ledger_path, output
    )
    claim_issues, claim_links = _claim_link_issues(benchmark)
    issues.extend(claim_issues)
    if regression.get("status") != "pass":
        issues.append("regression report is not pass")
    issues.extend(verification_evidence_issues(run_card, run_card_path))
    issues.extend(_checkpoint_gate_issues(benchmark, run_card, run_card_path))
    issues.extend(_ledger_issues(ledger_path, run_card.get("run_id")))
    issues.extend(_required_split_issues(benchmark, run_card, not issues))
    report = _build_gate_report(
        benchmark, run_card, issues, claim_links, ledger_path, regression_path
    )
    dump_json(output, report)
    if path_under_results(run_card_path):
        run_card["release_gate_status"] = report["status"]
        run_card["release_gate_report_path"] = repo_relpath(output)
        dump_json(run_card_path, run_card)
    print(repo_relpath(output))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
