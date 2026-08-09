#!/usr/bin/env python3
"""Compose release-gate contract checks and retain their stable import surface."""

import pathlib
from typing import Any

from common import iso_timestamp, path_exists, repo_relpath

from lib.release_gate_evidence import (
    _ARTIFACT_READ_ERRORS,
    REQUIRED_RUN_FIELDS,
    _benchmark_reference_issues,
    _calibration_issues,
    _candidate_matches,
    _checkpoint_gate_issues,
    _declared_input_issues,
    _ledger_registration_issues,
    _load_ledger_entries,
    _load_object,
    _prior_gate_report_issues,
    _provided_evidence_issues,
    _provided_types_match,
    _regression_status_issues,
    _required_field_issues,
    _result_artifact_issues,
    _result_payload_issues,
    _summary_evidence_issues,
    cross_split_evidence_issues,
    discover_release_gated_evidence,
    verification_evidence_issues,
)
from lib.release_gate_helpers import path_under_results
from lib.release_gate_resources import (
    _resource_policy_has_limit,
    _resource_usage_issues,
    _resource_usage_state_issues,
    _scalar_resource_issues,
    _total_token_issues,
)

__all__ = (
    "REQUIRED_RUN_FIELDS",
    "_ARTIFACT_READ_ERRORS",
    "_benchmark_reference_issues",
    "_build_gate_report",
    "_calibration_issues",
    "_candidate_matches",
    "_checkpoint_gate_issues",
    "_claim_link_issues",
    "_declared_input_issues",
    "_ledger_registration_issues",
    "_load_ledger_entries",
    "_load_object",
    "_numeric_field_issues",
    "_prior_gate_report_issues",
    "_provided_evidence_issues",
    "_provided_types_match",
    "_regression_status_issues",
    "_required_field_issues",
    "_required_split_issues",
    "_resource_policy_has_limit",
    "_resource_usage_issues",
    "_resource_usage_state_issues",
    "_result_artifact_issues",
    "_result_payload_issues",
    "_scalar_resource_issues",
    "_summary_evidence_issues",
    "_total_token_issues",
    "cross_split_evidence_issues",
    "discover_release_gated_evidence",
    "path_under_results",
    "validate_run_card_contract",
    "verification_evidence_issues",
)


def _numeric_field_issues(run_card: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for field in ("cost_usd", "latency_seconds"):
        value = run_card.get(field)
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            issues.append(f"run card has invalid {field}")
    return issues


def validate_run_card_contract(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
    regression_path: pathlib.Path,
    ledger_path: pathlib.Path,
    output_path: pathlib.Path,
) -> list[str]:
    issues = _required_field_issues(run_card)
    issues.extend(_benchmark_reference_issues(benchmark, run_card))
    split = run_card.get("split")
    if split is not None and split not in benchmark.get("split_policy", []):
        issues.append(f"run card split not allowed by benchmark card: {split}")
    issues.extend(_numeric_field_issues(run_card))
    issues.extend(_resource_usage_issues(benchmark, run_card))
    issues.extend(_result_artifact_issues(benchmark, run_card, run_card_path))
    issues.extend(_calibration_issues(run_card))
    issues.extend(
        _declared_input_issues(
            run_card,
            "regression_report_path",
            regression_path,
            "run card regression_report_path does not match provided regression report",
        )
    )
    issues.extend(
        _declared_input_issues(
            run_card,
            "ledger_path",
            ledger_path,
            "run card ledger_path does not match provided result ledger",
        )
    )
    if not path_under_results(run_card_path):
        issues.append("run card path is outside evals/results")
    if not path_under_results(output_path):
        issues.append("release gate report path is outside evals/results")
    return issues


def _claim_link_issues(benchmark: dict[str, Any]) -> tuple[list[str], list[Any]]:
    claim_links = benchmark.get("claim_links", [])
    required = benchmark.get("release_gate", {}).get("required_claim_links", claim_links)
    issues = [f"missing claim link: {link}" for link in required if not path_exists(link)]
    return issues, claim_links


def _required_split_issues(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    current_run_contract_ok: bool,
) -> list[str]:
    required = benchmark.get("release_gate", {}).get("required_splits", [])
    current_split = run_card.get("split", "")
    index = required.index(current_split) if current_split in required else len(required)
    issues: list[str] = []
    for split in required[:index]:
        found = discover_release_gated_evidence(
            benchmark,
            benchmark["benchmark_id"],
            benchmark["version"],
            split,
            run_card,
            current_run_contract_ok,
        )
        if not found:
            issues.append(f"missing passing release-gated evidence for required split: {split}")
    return issues


def _build_gate_report(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    issues: list[str],
    claim_links: list[Any],
    ledger_path: pathlib.Path,
    regression_path: pathlib.Path,
) -> dict[str, Any]:
    required_links = benchmark.get("release_gate", {}).get("required_claim_links", claim_links)
    evidence = run_card.get("verification_evidence")
    summary = evidence.get("summary", {}) if isinstance(evidence, dict) else {}
    return {
        "gate_id": f"release-gate-{run_card['run_id']}",
        "evaluated_at": iso_timestamp(),
        "benchmark_id": benchmark["benchmark_id"],
        "run_id": run_card["run_id"],
        "status": "pass" if not issues else "fail",
        "issues": issues,
        "verification_evidence": summary,
        "claim_links": claim_links,
        "required_claim_links": required_links,
        "ledger_path": repo_relpath(ledger_path),
        "regression_report_path": repo_relpath(regression_path),
    }
