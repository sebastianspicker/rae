#!/usr/bin/env python3
"""Validate eval benchmark and run metadata contracts for the umbrella repo."""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
EVALS = ROOT / "evals"
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


def load_json(path: pathlib.Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


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


def path_exists(relative_path: str) -> bool:
    return (ROOT / relative_path).exists()


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


def validate_delegation_contract(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")

    validate_allowed_paths(data, label)
    validate_optional_string_lists(data, label)
    validate_command_contract(data.get("verify"), label + ".verify")
    validate_guard(data, label)
    validate_required_evidence(data, label)
    fallback_rule = data.get("fallback_rule")
    if fallback_rule is not None and not isinstance(fallback_rule, str):
        raise ValueError(f"{label}.fallback_rule must be a string when present")


def validate_allowed_paths(data: dict[object, object], label: str) -> None:

    allowed_paths = data.get("allowed_paths")
    if not isinstance(allowed_paths, list) or not allowed_paths:
        raise ValueError(f"{label}.allowed_paths must be a non-empty array")
    for entry in allowed_paths:
        require_non_empty_string(entry, f"{label}.allowed_paths entries must be strings")


def validate_optional_string_lists(data: dict[object, object], label: str) -> None:
    for key in ("out_of_scope_paths", "dependency_task_ids"):
        values = data.get(key)
        if values is None:
            continue
        if not isinstance(values, list):
            raise ValueError(f"{label}.{key} must be an array when present")
        for entry in values:
            require_non_empty_string(entry, f"{label}.{key} entries must be strings")


def validate_guard(data: dict[object, object], label: str) -> None:
    guard = data.get("guard")
    if not isinstance(guard, dict):
        raise ValueError(f"{label}.guard must be an object")
    require_non_empty_string(guard.get("rule"), f"{label}.guard.rule must be a non-empty string")
    for key in ("command", "metric"):
        value = guard.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{label}.guard.{key} must be a string when present")


def validate_required_evidence(data: dict[object, object], label: str) -> None:
    required_evidence = data.get("required_evidence")
    if not isinstance(required_evidence, list) or not required_evidence:
        raise ValueError(f"{label}.required_evidence must be a non-empty array")
    for index, entry in enumerate(required_evidence):
        if not isinstance(entry, dict):
            raise ValueError(f"{label}.required_evidence[{index}] must be an object")
        require_non_empty_string(
            entry.get("type"),
            f"{label}.required_evidence[{index}].type must be a non-empty string",
        )
        require_non_empty_string(
            entry.get("why"),
            f"{label}.required_evidence[{index}].why must be a non-empty string",
        )
        required = entry.get("required")
        if required is not None and not isinstance(required, bool):
            raise ValueError(
                f"{label}.required_evidence[{index}].required must be boolean when present"
            )


def validate_verification_evidence(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} must be an object")

    validate_optional_evidence_types(data, label)
    validate_provided_evidence(data, label)
    validate_evidence_summary(data, label)
    validate_evidence_task_statuses(data, label)


def validate_optional_evidence_types(data: dict[object, object], label: str) -> None:

    required_types = data.get("required_types")
    if required_types is not None:
        if not isinstance(required_types, list):
            raise ValueError(f"{label}.required_types must be an array when present")
        for entry in required_types:
            require_non_empty_string(entry, f"{label}.required_types entries must be strings")


def validate_provided_evidence(data: dict[object, object], label: str) -> None:
    provided = data.get("provided")
    if not isinstance(provided, list):
        raise ValueError(f"{label}.provided must be an array")
    for index, entry in enumerate(provided):
        if not isinstance(entry, dict):
            raise ValueError(f"{label}.provided[{index}] must be an object")
        require_non_empty_string(
            entry.get("type"),
            f"{label}.provided[{index}].type must be a non-empty string",
        )
        require_non_empty_string(
            entry.get("path"),
            f"{label}.provided[{index}].path must be a non-empty string",
        )


def validate_evidence_summary(data: dict[object, object], label: str) -> None:
    summary = data.get("summary")
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


def validate_evidence_task_statuses(data: dict[object, object], label: str) -> None:
    task_statuses = data.get("task_statuses")
    if task_statuses is not None:
        if not isinstance(task_statuses, list):
            raise ValueError(f"{label}.task_statuses must be an array when present")
        for index, entry in enumerate(task_statuses):
            if not isinstance(entry, dict):
                raise ValueError(f"{label}.task_statuses[{index}] must be an object")
            require_non_empty_string(
                entry.get("task_id"),
                f"{label}.task_statuses[{index}].task_id must be a non-empty string",
            )
            if entry.get("status") not in EVIDENCE_SUMMARY_STATUSES:
                raise ValueError(f"{label}.task_statuses[{index}].status has invalid value")
            missing_types = entry.get("missing_types")
            if not isinstance(missing_types, list):
                raise ValueError(f"{label}.task_statuses[{index}].missing_types must be an array")
            for missing in missing_types:
                require_non_empty_string(
                    missing,
                    f"{label}.task_statuses[{index}].missing_types entries must be strings",
                )


def validate_judge_config(path: pathlib.Path) -> None:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a JSON object")
    for key in ("judge_id", "judge_version", "rubric_version", "calibration_cases"):
        if key not in data:
            raise ValueError(f"{path.relative_to(ROOT)} is missing key: {key}")
    cases = data["calibration_cases"]
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"{path.relative_to(ROOT)} calibration_cases must be non-empty")
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError(f"{path.relative_to(ROOT)} calibration case must be an object")
        if case.get("expected_verdict") not in {"pass", "fail"}:
            raise ValueError(
                f"{path.relative_to(ROOT)} calibration case has invalid expected_verdict"
            )


def validate_baseline_result(path: pathlib.Path) -> None:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a JSON object")
    metrics = data.get("aggregate_metrics")
    if not isinstance(metrics, dict) or not metrics:
        raise ValueError(f"{path.relative_to(ROOT)} aggregate_metrics must be a non-empty object")
