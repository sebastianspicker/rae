#!/usr/bin/env python3
"""Release gate helper functions for benchmark/run-card validation."""

import pathlib
from typing import Any

from common import (
    RESULTS_ROOT,
    ROOT,
    is_within_directory,
    load_json,
    resolve_metadata_path,
)

EVIDENCE_TYPE_JSON_KEYS: dict[str, set[str]] = {
    "coverage-ledger": {"coverage_ledger"},
    "qc-summary": {"qc_summary"},
    "risk-summary": {"open_risks", "review_state"},
}


def run_scope_root(run_card_path: pathlib.Path) -> pathlib.Path:
    return run_card_path.resolve(strict=False).parent


def path_within_run_scope(path: pathlib.Path, run_card_path: pathlib.Path) -> bool:
    return is_within_directory(path, run_scope_root(run_card_path))


def resolve_repo_path(path_str: object, label: str = "path") -> pathlib.Path:
    return resolve_metadata_path(path_str, label=label, contained_by=ROOT)


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
    try:
        path = resolve_metadata_path(ref, label=label, contained_by=RESULTS_ROOT)
    except ValueError as exc:
        return None, [str(exc)]
    if not path.exists():
        return None, [f"{label} missing"]
    return path, []


def _checkpoint_status(
    path_ref: object,
    *,
    index: int,
    run_id: object,
    run_card_path: pathlib.Path,
) -> tuple[str | None, str | None]:
    if not isinstance(path_ref, str) or not path_ref:
        return None, f"checkpoint_paths[{index}] must be a non-empty string"
    try:
        path = resolve_metadata_path(path_ref, label="checkpoint path", contained_by=RESULTS_ROOT)
    except ValueError as exc:
        return None, str(exc)
    if not path_within_run_scope(path, run_card_path):
        return None, f"checkpoint path outside current run scope: {path_ref}"
    if not path.exists():
        return None, f"checkpoint missing: {path_ref}"
    checkpoint = load_json(path)
    if not isinstance(checkpoint, dict):
        return None, f"checkpoint must be a JSON object: {path_ref}"
    if checkpoint.get("run_id") != run_id:
        return None, f"checkpoint run_id mismatch: {path_ref}"
    return str(checkpoint.get("status", "unknown")), None


def validate_checkpoint_statuses(
    run_card: dict[str, Any], run_card_path: pathlib.Path
) -> tuple[list[str], list[str]]:
    checkpoint_paths = run_card.get("checkpoint_paths", [])
    if checkpoint_paths is None:
        return [], []
    if not isinstance(checkpoint_paths, list):
        return [], ["checkpoint_paths must be an array when present"]
    statuses: list[str] = []
    issues: list[str] = []
    for index, path_ref in enumerate(checkpoint_paths):
        status, issue = _checkpoint_status(
            path_ref,
            index=index,
            run_id=run_card.get("run_id"),
            run_card_path=run_card_path,
        )
        if issue:
            issues.append(issue)
        elif status:
            statuses.append(status)
    return statuses, issues


def _resolve_evidence_path(
    path_ref: object, entry_label: str, run_card_path: pathlib.Path
) -> tuple[pathlib.Path | None, list[str]]:
    if not isinstance(path_ref, str) or not path_ref:
        return None, [f"{entry_label}.path must be a non-empty string"]
    try:
        path = resolve_metadata_path(
            path_ref, label=f"{entry_label} path", contained_by=RESULTS_ROOT
        )
    except ValueError as exc:
        return None, [str(exc)]
    if not path_within_run_scope(path, run_card_path):
        return None, [f"{entry_label} path outside current run scope: {path_ref}"]
    if not path.exists():
        return None, [f"{entry_label} missing path: {path_ref}"]
    return path, []


def _validate_command_log(path: pathlib.Path, entry_label: str) -> list[str]:
    if path.is_dir() or path.suffix != ".json":
        return [f"{entry_label} command-log must point to a JSON file"]
    payload = load_json(path)
    if not isinstance(payload, dict):
        return [f"{entry_label} command-log must be a JSON object"]
    required = {"argv", "returncode", "stdout", "stderr", "duration_seconds"}
    missing = sorted(required - set(payload))
    if missing:
        return [f"{entry_label} command-log missing keys: {', '.join(missing)}"]
    return []


def _validate_checkpoint_evidence(
    payload: dict[str, Any],
    entry_label: str,
    path_ref: str,
    run_card: dict[str, Any],
) -> list[str]:
    issues: list[str] = []
    if payload.get("run_id") != run_card.get("run_id"):
        issues.append(f"{entry_label} checkpoint run_id mismatch: {path_ref}")
    if "status" not in payload:
        issues.append(f"{entry_label} checkpoint missing status: {path_ref}")
    return issues


def _required_evidence_key_issues(
    payload: dict[str, Any],
    evidence_type: str,
    entry_label: str,
    path_ref: str,
) -> list[str]:
    required = EVIDENCE_TYPE_JSON_KEYS.get(evidence_type)
    if required and not any(key in payload for key in required):
        return [f"{entry_label} does not match claimed type {evidence_type}: {path_ref}"]
    return []


def _validate_json_evidence(
    path: pathlib.Path,
    evidence_type: str,
    entry_label: str,
    path_ref: str,
    run_card: dict[str, Any],
) -> list[str]:
    if path.is_dir():
        return [f"{entry_label} must point to a JSON file, not a directory"]
    payload = load_json(path)
    if not isinstance(payload, dict):
        return [f"{entry_label} must point to a JSON object"]
    issues: list[str] = []
    payload_run_id = payload.get("run_id")
    if payload_run_id is not None and payload_run_id != run_card.get("run_id"):
        issues.append(f"{entry_label} run_id mismatch: {path_ref}")
    if evidence_type == "checkpoint":
        issues.extend(_validate_checkpoint_evidence(payload, entry_label, path_ref, run_card))
    issues.extend(_required_evidence_key_issues(payload, evidence_type, entry_label, path_ref))
    return issues


def validate_verification_evidence_entry(
    entry: dict[str, Any],
    *,
    index: int,
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    evidence_type = entry.get("type")
    path_ref = entry.get("path")
    label = f"verification_evidence.provided[{index}]"
    if not isinstance(evidence_type, str) or not evidence_type:
        return [f"{label}.type must be a non-empty string"]
    path, issues = _resolve_evidence_path(path_ref, label, run_card_path)
    if path is None:
        return issues
    if evidence_type == "artifact":
        return []
    if evidence_type == "trace":
        if path.suffix not in {".jsonl", ".log"}:
            return [f"{label} trace path must be .jsonl or .log: {path_ref}"]
        return []
    if evidence_type == "command-log":
        return _validate_command_log(path, label)
    return _validate_json_evidence(path, evidence_type, label, str(path_ref), run_card)
