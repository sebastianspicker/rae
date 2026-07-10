#!/usr/bin/env python3
"""Release gate helper functions for benchmark/run-card validation."""

from __future__ import annotations

import pathlib
from typing import Any

from common import RESULTS_ROOT, ROOT, is_within_directory, load_json

EVIDENCE_TYPE_JSON_KEYS: dict[str, set[str]] = {
    "coverage-ledger": {"coverage_ledger"},
    "qc-summary": {"qc_summary"},
    "risk-summary": {"open_risks", "review_state"},
}
def run_scope_root(run_card_path: pathlib.Path) -> pathlib.Path:
    return run_card_path.resolve(strict=False).parent


def path_within_run_scope(path: pathlib.Path, run_card_path: pathlib.Path) -> bool:
    return is_within_directory(path, run_scope_root(run_card_path))


def resolve_repo_path(path_str: str) -> pathlib.Path:
    path = pathlib.Path(path_str)
    return (path if path.is_absolute() else ROOT / path).resolve(strict=False)


def path_under_results(path: pathlib.Path) -> bool:
    return is_within_directory(path, RESULTS_ROOT)


def same_repo_path(left: pathlib.Path, right: pathlib.Path) -> bool:
    left_resolved = left.resolve(strict=False)
    right_resolved = right.resolve(strict=False)
    if left_resolved.exists() and right_resolved.exists():
        try:
            return left_resolved.samefile(right_resolved)
        except FileNotFoundError:
            pass
    return left_resolved == right_resolved


def resolve_declared_results_path(
    run_card: dict[str, Any], field: str, label: str
) -> tuple[pathlib.Path | None, list[str]]:
    ref = run_card.get(field)
    if not isinstance(ref, str) or not ref:
        return None, [f"run card missing {label}"]
    path = resolve_repo_path(ref)
    if not path_under_results(path):
        return None, [f"{label} is outside evals/results"]
    if not path.exists():
        return None, [f"{label} missing"]
    return path, []


def validate_checkpoint_statuses(
    run_card: dict[str, Any], run_card_path: pathlib.Path
) -> tuple[list[str], list[str]]:
    statuses: list[str] = []
    issues: list[str] = []
    checkpoint_paths = run_card.get("checkpoint_paths", [])
    if checkpoint_paths is None:
        return statuses, issues
    if not isinstance(checkpoint_paths, list):
        return statuses, ["checkpoint_paths must be an array when present"]

    run_id = run_card.get("run_id")
    for index, path_str in enumerate(checkpoint_paths):
        status, issue = _checkpoint_status(path_str, index, run_id, run_card_path)
        if issue:
            issues.append(issue)
        elif status:
            statuses.append(status)
    return statuses, issues


def _checkpoint_status(
    path_ref: object, index: int, run_id: object, run_card_path: pathlib.Path
) -> tuple[str | None, str | None]:
    if not isinstance(path_ref, str) or not path_ref:
        return None, f"checkpoint_paths[{index}] must be a non-empty string"
    path = resolve_repo_path(path_ref)
    issue = _validate_checkpoint_path(path, path_ref, run_card_path)
    if issue:
        return None, issue
    checkpoint = load_json(path)
    if not isinstance(checkpoint, dict):
        return None, f"checkpoint must be a JSON object: {path_ref}"
    if checkpoint.get("run_id") != run_id:
        return None, f"checkpoint run_id mismatch: {path_ref}"
    return str(checkpoint.get("status", "unknown")), None


def _validate_checkpoint_path(
    path: pathlib.Path, path_ref: str, run_card_path: pathlib.Path
) -> str | None:
    if not path_under_results(path):
        return f"checkpoint path outside evals/results: {path_ref}"
    if not path_within_run_scope(path, run_card_path):
        return f"checkpoint path outside current run scope: {path_ref}"
    if not path.exists():
        return f"checkpoint missing: {path_ref}"
    return None


def _validate_command_log(path: pathlib.Path, label: str) -> list[str]:
    if path.is_dir() or path.suffix != ".json":
        return [f"{label} command-log must point to a JSON file"]
    payload = load_json(path)
    if not isinstance(payload, dict):
        return [f"{label} command-log must be a JSON object"]
    required_keys = {"argv", "returncode", "stdout", "stderr", "duration_seconds"}
    missing = sorted(required_keys - set(payload))
    return [f"{label} command-log missing keys: {', '.join(missing)}"] if missing else []


def _validate_json_evidence(
    path: pathlib.Path,
    evidence_type: str,
    evidence_path_ref: str,
    label: str,
    run_id: object,
) -> list[str]:
    if path.is_dir():
        return [f"{label} must point to a JSON file, not a directory"]
    payload = load_json(path)
    if not isinstance(payload, dict):
        return [f"{label} must point to a JSON object"]
    issues = _run_id_issues(payload, run_id, label, evidence_path_ref)
    if evidence_type == "checkpoint":
        issues.extend(_checkpoint_evidence_issues(payload, run_id, label, evidence_path_ref))
        return issues
    required_keys = EVIDENCE_TYPE_JSON_KEYS.get(evidence_type)
    if required_keys and not any(key in payload for key in required_keys):
        issues.append(
            f"{label} does not match claimed type {evidence_type}: {evidence_path_ref}"
        )
    return issues


def _run_id_issues(
    payload: dict[str, Any], run_id: object, label: str, path_ref: str
) -> list[str]:
    if payload.get("run_id") is not None and payload.get("run_id") != run_id:
        return [f"{label} run_id mismatch: {path_ref}"]
    return []


def _checkpoint_evidence_issues(
    payload: dict[str, Any], run_id: object, label: str, path_ref: str
) -> list[str]:
    issues: list[str] = []
    if payload.get("run_id") != run_id:
        issues.append(f"{label} checkpoint run_id mismatch: {path_ref}")
    if "status" not in payload:
        issues.append(f"{label} checkpoint missing status: {path_ref}")
    return issues


def validate_verification_evidence_entry(
    entry: dict[str, Any],
    *,
    index: int,
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    evidence_type = entry.get("type")
    evidence_path_ref = entry.get("path")
    entry_label = f"verification_evidence.provided[{index}]"
    validated = _resolve_evidence_path(evidence_type, evidence_path_ref, entry_label, run_card_path)
    if isinstance(validated, list):
        return validated
    evidence_type, evidence_path_ref, evidence_path = validated

    if evidence_type == "artifact":
        return []

    if evidence_type == "trace":
        return (
            []
            if evidence_path.suffix in {".jsonl", ".log"}
            else [f"{entry_label} trace path must be .jsonl or .log: {evidence_path_ref}"]
        )

    if evidence_type == "command-log":
        return _validate_command_log(evidence_path, entry_label)
    return _validate_json_evidence(
        evidence_path,
        evidence_type,
        evidence_path_ref,
        entry_label,
        run_card.get("run_id"),
    )


def _resolve_evidence_path(
    evidence_type: object, path_ref: object, label: str, run_card_path: pathlib.Path
) -> tuple[str, str, pathlib.Path] | list[str]:
    if not isinstance(evidence_type, str) or not evidence_type:
        return [f"{label}.type must be a non-empty string"]
    if not isinstance(path_ref, str) or not path_ref:
        return [f"{label}.path must be a non-empty string"]
    path = resolve_repo_path(path_ref)
    issue = _evidence_path_issue(path, path_ref, label, run_card_path)
    return [issue] if issue else (evidence_type, path_ref, path)


def _evidence_path_issue(
    path: pathlib.Path, path_ref: str, label: str, run_card_path: pathlib.Path
) -> str | None:
    if not path_under_results(path):
        return f"{label} path outside evals/results: {path_ref}"
    if not path_within_run_scope(path, run_card_path):
        return f"{label} path outside current run scope: {path_ref}"
    if not path.exists():
        return f"{label} missing path: {path_ref}"
    return None
