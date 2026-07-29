#!/usr/bin/env python3
"""Release gate CLI and core checks."""

import json
import pathlib
from typing import Any, cast

from common import (
    RESULTS_ROOT,
    iso_timestamp,
    load_json,
    load_json_object,
    path_exists,
    repo_relpath,
    resolve_metadata_path,
)

from lib.release_gate_helpers import (
    path_under_results,
    path_within_run_scope,
    resolve_declared_results_path,
    same_repo_path,
    validate_checkpoint_statuses,
    validate_verification_evidence_entry,
)

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


def _load_object(path: pathlib.Path) -> dict[str, Any]:
    return cast(dict[str, Any], load_json_object(path))


def _required_field_issues(run_card: dict[str, Any]) -> list[str]:
    return [
        f"run card missing required field: {field}"
        for field in REQUIRED_RUN_FIELDS
        if run_card.get(field) in (None, "")
    ]


def _benchmark_reference_issues(benchmark: dict[str, Any], run_card: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if run_card.get("benchmark_id") not in (None, benchmark["benchmark_id"]):
        issues.append("run card benchmark_id does not match benchmark card")
    if run_card.get("benchmark_version") not in (None, benchmark["version"]):
        issues.append("run card benchmark_version does not match benchmark card")
    return issues


def _checkpoint_gate_issues(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    states, issues = validate_checkpoint_statuses(run_card, run_card_path)
    block_pending = benchmark.get("release_gate", {}).get("block_on_pending_checkpoints", True)
    if block_pending:
        issues.extend(
            f"checkpoint not approved: {state}" for state in states if state != "approved"
        )
    return issues


def _load_ledger_entries(path: pathlib.Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            entry = json.loads(line)
            if isinstance(entry, dict):
                entries.append(cast(dict[str, Any], entry))
    return entries


def _ledger_registration_issues(ledger_path: pathlib.Path, run_id: object) -> list[str]:
    try:
        entries = _load_ledger_entries(ledger_path)
    except Exception:
        return ["result ledger could not be read"]
    if not any(entry.get("run_id") == run_id for entry in entries):
        return ["run_id missing from result ledger"]
    return []


def _regression_status_issues(path: pathlib.Path) -> list[str]:
    try:
        regression = _load_object(path)
    except Exception:
        return ["regression report could not be read"]
    if regression.get("status") != "pass":
        return ["regression report is not pass"]
    return []


def _prior_gate_report_issues(run_card: dict[str, Any]) -> list[str]:
    if run_card.get("release_gate_status") is None:
        return []
    gate_path, issues = resolve_declared_results_path(
        run_card, "release_gate_report_path", "release gate report"
    )
    if gate_path is None:
        return issues
    try:
        gate_report = _load_object(gate_path)
    except Exception:
        return [*issues, "release gate report could not be read"]
    if gate_report.get("run_id") != run_card.get("run_id"):
        issues.append("release gate report run_id mismatch")
    return issues


def cross_split_evidence_issues(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    """Validate non-circular evidence for an earlier required split."""
    regression_path, regression_issues = resolve_declared_results_path(
        run_card, "regression_report_path", "regression report"
    )
    ledger_path, ledger_issues = resolve_declared_results_path(
        run_card, "ledger_path", "result ledger"
    )
    issues = [*regression_issues, *ledger_issues]
    if regression_path is None or ledger_path is None:
        return issues
    issues.extend(_required_field_issues(run_card))
    issues.extend(_benchmark_reference_issues(benchmark, run_card))
    issues.extend(_regression_status_issues(regression_path))
    issues.extend(verification_evidence_issues(run_card, run_card_path))
    issues.extend(_checkpoint_gate_issues(benchmark, run_card, run_card_path))
    issues.extend(_ledger_registration_issues(ledger_path, run_card.get("run_id")))
    issues.extend(_prior_gate_report_issues(run_card))
    return issues


def _candidate_matches(
    candidate: dict[str, Any],
    benchmark_id: str,
    benchmark_version: str,
    required_split: str,
) -> bool:
    return all(
        (
            candidate.get("evidence_type", "benchmark-run") == "benchmark-run",
            candidate.get("benchmark_id") == benchmark_id,
            candidate.get("benchmark_version") == benchmark_version,
            candidate.get("split") == required_split,
        )
    )


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
            candidate = _load_object(path)
        except (json.JSONDecodeError, ValueError):
            continue
        if not _candidate_matches(candidate, benchmark_id, benchmark_version, required_split):
            continue
        if not cross_split_evidence_issues(benchmark, candidate, path):
            return True
    return False


def _numeric_field_issues(run_card: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for field in ("cost_usd", "latency_seconds"):
        value = run_card.get(field)
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            issues.append(f"run card has invalid {field}")
    return issues


def _resource_policy_has_limit(policy: dict[str, Any]) -> bool:
    """Report whether a policy needs a resource-usage payload to enforce a limit."""
    return any(
        policy.get(field) is not None
        for field in (
            "max_agent_duration_seconds",
            "max_agent_calls",
            "max_parallelism",
            "max_total_tokens",
        )
    )


def _scalar_resource_issues(policy: dict[str, Any], usage: dict[str, Any]) -> list[str]:
    """Compare independently measured scalar resources with their policy limits."""
    limits = (
        ("max_agent_duration_seconds", "agent_duration_seconds"),
        ("max_agent_calls", "agent_calls"),
        ("max_parallelism", "max_parallelism"),
    )
    issues: list[str] = []
    for policy_field, usage_field in limits:
        limit = policy.get(policy_field)
        value = usage.get(usage_field)
        if limit is not None and (not isinstance(value, (int, float)) or value > limit):
            issues.append(f"run card exceeds resource policy {policy_field}")
    return issues


def _total_token_issues(policy: dict[str, Any], usage: dict[str, Any]) -> list[str]:
    """Require both token counters before enforcing a combined token limit."""
    total_limit = policy.get("max_total_tokens")
    if total_limit is None:
        return []
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return ["run card lacks total-token measurement"]
    if input_tokens + output_tokens > total_limit:
        return ["run card exceeds resource policy max_total_tokens"]
    return []


def _resource_usage_state_issues(policy: dict[str, Any], usage: object) -> list[str]:
    if not isinstance(usage, dict):
        return (
            ["run card missing resource_usage"]
            if policy.get("require_measurement") or _resource_policy_has_limit(policy)
            else []
        )
    status = usage.get("measurement_status")
    if status not in {"complete", "partial", "unavailable"}:
        return ["run card has invalid resource_usage.measurement_status"]
    if policy.get("require_measurement") and status != "complete":
        return ["run card resource measurement is not complete"]
    return []


def _resource_usage_issues(benchmark: dict[str, Any], run_card: dict[str, Any]) -> list[str]:
    """Enforce an optional resource policy without treating unknown usage as zero."""
    policy = benchmark.get("resource_policy")
    if policy is None:
        return []
    if not isinstance(policy, dict):
        return ["benchmark resource_policy must be an object"]
    usage = run_card.get("resource_usage")
    issues = _resource_usage_state_issues(policy, usage)
    if not isinstance(usage, dict):
        return issues
    issues.extend(_scalar_resource_issues(policy, usage))
    issues.extend(_total_token_issues(policy, usage))
    return issues


def _result_payload_issues(
    result: object,
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
) -> list[str]:
    if not isinstance(result, dict):
        return ["benchmark result must be a JSON object"]
    checks = (
        ("run_id", run_card.get("run_id"), "benchmark result run_id mismatch"),
        (
            "benchmark_id",
            benchmark["benchmark_id"],
            "benchmark result benchmark_id mismatch",
        ),
        (
            "benchmark_version",
            benchmark["version"],
            "benchmark result benchmark_version mismatch",
        ),
        ("split", run_card.get("split"), "benchmark result split mismatch"),
    )
    for field, expected, message in checks:
        if result.get(field) != expected:
            return [message]
    if "fail_count" not in result or "task_count" not in result:
        return ["benchmark result missing failure summary"]
    if "aggregate_metrics" not in result:
        return ["benchmark result missing aggregate_metrics"]
    return []


def _result_artifact_issues(
    benchmark: dict[str, Any],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    result_ref = run_card.get("result_path")
    if not result_ref:
        return []
    try:
        result_path = resolve_metadata_path(
            result_ref, label="run card result_path", contained_by=RESULTS_ROOT
        )
    except ValueError as exc:
        return [str(exc)]
    if not path_within_run_scope(result_path, run_card_path):
        return ["run card result_path is outside current run scope"]
    if not result_path.exists():
        return ["benchmark result artifact missing"]
    return _result_payload_issues(load_json(result_path), benchmark, run_card)


def _calibration_issues(run_card: dict[str, Any]) -> list[str]:
    calibration_ref = run_card.get("judge_calibration_report_path")
    if not calibration_ref:
        return []
    try:
        path = resolve_metadata_path(
            calibration_ref,
            label="judge calibration report",
            contained_by=RESULTS_ROOT,
        )
    except ValueError as exc:
        return [str(exc)]
    if not path.exists():
        return ["judge calibration report missing"]
    calibration = load_json(path)
    if not isinstance(calibration, dict):
        return ["judge calibration report must be a JSON object"]
    if calibration.get("calibration_case_count", 0) <= 0:
        return ["judge calibration report has no calibration cases"]
    rate = calibration.get("agreement_rate")
    if not isinstance(rate, (int, float)):
        return ["judge calibration report missing agreement_rate"]
    if rate < 1.0:
        return ["judge calibration agreement_rate is below required threshold"]
    return []


def _declared_input_issues(
    run_card: dict[str, Any],
    field: str,
    provided_path: pathlib.Path,
    mismatch_message: str,
) -> list[str]:
    path_ref = run_card.get(field)
    if not path_ref:
        return []
    try:
        declared = resolve_metadata_path(
            path_ref, label=f"run card {field}", contained_by=RESULTS_ROOT
        )
    except ValueError as exc:
        return [str(exc)]
    return [] if same_repo_path(declared, provided_path) else [mismatch_message]


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


def _summary_evidence_issues(summary: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    status = summary.get("status")
    if status in {"partial", "missing"}:
        issues.append(f"verification evidence incomplete: {status}")
    missing_types = summary.get("missing_types", [])
    if isinstance(missing_types, list):
        issues.extend(
            f"missing required verification evidence type: {evidence_type}"
            for evidence_type in missing_types
            if isinstance(evidence_type, str) and evidence_type
        )
    return issues


def _provided_evidence_issues(
    provided: list[object],
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> tuple[list[str], set[str]]:
    issues: list[str] = []
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
                entry, index=index, run_card=run_card, run_card_path=run_card_path
            )
        )
    return issues, validated_types


def _provided_types_match(summary: dict[str, Any], validated_types: set[str]) -> bool:
    declared = summary.get("provided_types")
    if not isinstance(declared, list):
        return True
    declared_types = {entry for entry in declared if isinstance(entry, str) and entry}
    return declared_types == validated_types


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
    issues = _summary_evidence_issues(summary)
    provided = evidence.get("provided")
    if not isinstance(provided, list):
        return [*issues, "verification_evidence.provided missing"]
    provided_issues, validated_types = _provided_evidence_issues(provided, run_card, run_card_path)
    issues.extend(provided_issues)
    if not _provided_types_match(summary, validated_types):
        issues.append("verification evidence provided_types does not match provided entries")
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
