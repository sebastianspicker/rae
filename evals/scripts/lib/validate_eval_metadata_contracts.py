#!/usr/bin/env python3
"""Validate eval benchmark and run metadata contracts for the umbrella repo."""

import pathlib
from collections.abc import Sequence
from typing import cast

from common import (
    EVALS,
    RESULTS_ROOT,
    ROOT,
    load_json_object,
    resolve_metadata_path,
)

BENCHMARK_SPLITS = {"dev", "held-out", "stress", "ablation"}
BENCHMARK_STATUSES = {"draft", "experimental", "frozen", "deprecated"}
JUDGE_TYPES = {"programmatic", "rubric", "hybrid"}
CONTAMINATION_RISKS = {"low", "medium", "high"}
PUBLICATION_STATUSES = {"internal-only", "public-draft", "public-reportable"}
RUNTIME_CHOICES = {"orchestration", "ralph", "tool"}
RUN_EVIDENCE_TYPES = {"benchmark-run", "operator-run", "vendor-doc"}
RUN_STATUSES = {"planned", "pass", "fail", "blocked", "observed"}
WORKFLOW_VERBS = {"discover", "plan", "implement", "review", "compound"}
EVIDENCE_SUMMARY_STATUSES = {"complete", "partial", "missing"}


def iter_benchmark_paths() -> list[pathlib.Path]:
    paths = {EVALS / "benchmark-card.example.json"}
    paths.update(EVALS.rglob("*.benchmark-card.json"))
    return sorted(path for path in paths if path.exists())


def iter_run_paths() -> list[pathlib.Path]:
    paths = {EVALS / "run-card.example.json"}
    paths.update(EVALS.rglob("*.run-card.json"))
    paths.update(EVALS.rglob("run-card-*.json"))
    return sorted(path for path in paths if path.exists())


def iter_task_bundle_paths() -> list[pathlib.Path]:
    return sorted(EVALS.rglob("*.task-specs.json"))


def iter_outcome_bundle_paths() -> list[pathlib.Path]:
    return sorted(EVALS.rglob("*.task-bundle.json"))


def iter_optimizer_campaign_paths() -> list[pathlib.Path]:
    campaigns = EVALS / "campaigns"
    return sorted(campaigns.glob("*.json")) if campaigns.exists() else []


def require_non_empty_string(value: object, message: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(message)


def validate_command_contract(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")
    require_non_empty_string(data.get("command"), f"{label}.command must be a non-empty string")
    for key in ("working_directory", "success_signal"):
        value = data.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{label}.{key} must be a string when present")
    working_directory = data.get("working_directory")
    if working_directory is not None:
        resolve_metadata_path(
            working_directory,
            label=f"{label}.working_directory",
            contained_by=ROOT,
        )


def _require_string_list(
    value: object,
    label: str,
    *,
    required: bool = False,
) -> list[str]:
    if not isinstance(value, list) or (required and not value):
        qualifier = "non-empty " if required else ""
        raise ValueError(f"{label} must be a {qualifier}array")
    for entry in value:
        require_non_empty_string(entry, f"{label} entries must be strings")
    return cast(list[str], value)


def _validate_metadata_path_list(value: object, label: str, *, required: bool) -> None:
    for entry in _require_string_list(value, label, required=required):
        resolve_metadata_path(entry, label=f"{label} entry", contained_by=ROOT)


def _validate_delegation_guard(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label}.guard must be an object")
    require_non_empty_string(data.get("rule"), f"{label}.guard.rule must be a non-empty string")
    for key in ("command", "metric"):
        value = data.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{label}.guard.{key} must be a string when present")


def _validate_required_evidence(data: object, label: str) -> None:
    if not isinstance(data, list) or not data:
        raise ValueError(f"{label}.required_evidence must be a non-empty array")
    for index, entry in enumerate(data):
        entry_label = f"{label}.required_evidence[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{entry_label} must be an object")
        require_non_empty_string(
            entry.get("type"), f"{entry_label}.type must be a non-empty string"
        )
        require_non_empty_string(entry.get("why"), f"{entry_label}.why must be a non-empty string")
        required = entry.get("required")
        if required is not None and not isinstance(required, bool):
            raise ValueError(f"{entry_label}.required must be boolean when present")


def validate_delegation_contract(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")

    _validate_metadata_path_list(data.get("allowed_paths"), f"{label}.allowed_paths", required=True)
    out_of_scope = data.get("out_of_scope_paths")
    if out_of_scope is not None:
        _validate_metadata_path_list(out_of_scope, f"{label}.out_of_scope_paths", required=False)
    dependency_ids = data.get("dependency_task_ids")
    if dependency_ids is not None:
        _require_string_list(dependency_ids, f"{label}.dependency_task_ids")
    validate_command_contract(data.get("verify"), label + ".verify")
    _validate_delegation_guard(data.get("guard"), label)
    _validate_required_evidence(data.get("required_evidence"), label)
    fallback_rule = data.get("fallback_rule")
    if fallback_rule is not None and not isinstance(fallback_rule, str):
        raise ValueError(f"{label}.fallback_rule must be a string when present")


def _validate_provided_evidence(provided: object, label: str) -> None:
    if not isinstance(provided, list):
        raise ValueError(f"{label}.provided must be an array")
    for index, entry in enumerate(provided):
        entry_label = f"{label}.provided[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{entry_label} must be an object")
        require_non_empty_string(
            entry.get("type"), f"{entry_label}.type must be a non-empty string"
        )
        require_non_empty_string(
            entry.get("path"), f"{entry_label}.path must be a non-empty string"
        )
        resolve_metadata_path(
            entry.get("path"),
            label=f"{entry_label}.path",
            contained_by=RESULTS_ROOT,
        )


def _validate_evidence_summary(summary: object, label: str) -> None:
    if not isinstance(summary, dict):
        raise ValueError(f"{label}.summary must be an object")
    status = summary.get("status")
    if status not in EVIDENCE_SUMMARY_STATUSES:
        raise ValueError(f"{label}.summary.status has invalid value")
    for key in ("provided_types", "missing_types", "residual_gaps"):
        values = summary.get(key)
        if not isinstance(values, list):
            raise ValueError(f"{label}.summary.{key} must be an array")
        for entry in values:
            require_non_empty_string(entry, f"{label}.summary.{key} entries must be strings")


def _validate_task_statuses(task_statuses: object, label: str) -> None:
    if not isinstance(task_statuses, list):
        raise ValueError(f"{label}.task_statuses must be an array when present")
    for index, entry in enumerate(task_statuses):
        entry_label = f"{label}.task_statuses[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{entry_label} must be an object")
        require_non_empty_string(
            entry.get("task_id"), f"{entry_label}.task_id must be a non-empty string"
        )
        if entry.get("status") not in EVIDENCE_SUMMARY_STATUSES:
            raise ValueError(f"{entry_label}.status has invalid value")
        _require_string_list(entry.get("missing_types"), f"{entry_label}.missing_types")


def validate_verification_evidence(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")
    required_types = data.get("required_types")
    if required_types is not None:
        _require_string_list(required_types, f"{label}.required_types")
    _validate_provided_evidence(data.get("provided"), label)
    _validate_evidence_summary(data.get("summary"), label)
    task_statuses = data.get("task_statuses")
    if task_statuses is not None:
        _validate_task_statuses(task_statuses, label)


def _validate_calibration_cases(cases: Sequence[object], label: str) -> None:
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError(f"{label} calibration case must be an object")
        if case.get("expected_verdict") not in {"pass", "fail"}:
            raise ValueError(f"{label} calibration case has invalid expected_verdict")


def validate_judge_config(path: pathlib.Path) -> None:
    data = load_json_object(path)
    for key in ("judge_id", "judge_version", "rubric_version", "calibration_cases"):
        if key not in data:
            raise ValueError(f"{path.relative_to(ROOT)} is missing key: {key}")
    cases = data["calibration_cases"]
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{path.relative_to(ROOT)} calibration_cases must be non-empty")
    _validate_calibration_cases(cases, str(path.relative_to(ROOT)))


def validate_baseline_result(path: pathlib.Path) -> None:
    data = load_json_object(path)
    metrics = data.get("aggregate_metrics")
    if not isinstance(metrics, dict) or not metrics:
        raise ValueError(f"{path.relative_to(ROOT)} aggregate_metrics must be a non-empty object")
