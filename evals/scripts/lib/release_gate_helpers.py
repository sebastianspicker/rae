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
        if not isinstance(path_str, str) or not path_str:
            issues.append(f"checkpoint_paths[{index}] must be a non-empty string")
            continue
        checkpoint_path = resolve_repo_path(path_str)
        if not path_under_results(checkpoint_path):
            issues.append(f"checkpoint path outside evals/results: {path_str}")
            continue
        if not path_within_run_scope(checkpoint_path, run_card_path):
            issues.append(f"checkpoint path outside current run scope: {path_str}")
            continue
        if not checkpoint_path.exists():
            issues.append(f"checkpoint missing: {path_str}")
            continue
        checkpoint = load_json(checkpoint_path)
        if not isinstance(checkpoint, dict):
            issues.append(f"checkpoint must be a JSON object: {path_str}")
            continue
        if checkpoint.get("run_id") != run_id:
            issues.append(f"checkpoint run_id mismatch: {path_str}")
            continue
        statuses.append(str(checkpoint.get("status", "unknown")))
    return statuses, issues


def validate_verification_evidence_entry(
    entry: dict[str, Any],
    *,
    index: int,
    run_card: dict[str, Any],
    run_card_path: pathlib.Path,
) -> list[str]:
    issues: list[str] = []
    evidence_type = entry.get("type")
    evidence_path_ref = entry.get("path")
    entry_label = f"verification_evidence.provided[{index}]"
    if not isinstance(evidence_type, str) or not evidence_type:
        return [f"{entry_label}.type must be a non-empty string"]
    if not isinstance(evidence_path_ref, str) or not evidence_path_ref:
        return [f"{entry_label}.path must be a non-empty string"]

    evidence_path = resolve_repo_path(evidence_path_ref)
    if not path_under_results(evidence_path):
        return [f"{entry_label} path outside evals/results: {evidence_path_ref}"]
    if not path_within_run_scope(evidence_path, run_card_path):
        return [f"{entry_label} path outside current run scope: {evidence_path_ref}"]
    if not evidence_path.exists():
        return [f"{entry_label} missing path: {evidence_path_ref}"]

    if evidence_type == "artifact":
        return issues

    if evidence_type == "trace":
        if evidence_path.suffix not in {".jsonl", ".log"}:
            issues.append(
                f"{entry_label} trace path must be .jsonl or .log: {evidence_path_ref}"
            )
        return issues

    if evidence_type == "command-log":
        if evidence_path.is_dir() or evidence_path.suffix != ".json":
            issues.append(f"{entry_label} command-log must point to a JSON file")
            return issues
        payload = load_json(evidence_path)
        if not isinstance(payload, dict):
            issues.append(f"{entry_label} command-log must be a JSON object")
            return issues
        required_keys = {"argv", "returncode", "stdout", "stderr", "duration_seconds"}
        missing = sorted(required_keys - set(payload))
        if missing:
            issues.append(
                f"{entry_label} command-log missing keys: {', '.join(missing)}"
            )
        return issues

    if evidence_path.is_dir():
        issues.append(f"{entry_label} must point to a JSON file, not a directory")
        return issues

    payload = load_json(evidence_path)
    if not isinstance(payload, dict):
        issues.append(f"{entry_label} must point to a JSON object")
        return issues

    payload_run_id = payload.get("run_id")
    if payload_run_id is not None and payload_run_id != run_card.get("run_id"):
        issues.append(f"{entry_label} run_id mismatch: {evidence_path_ref}")

    if evidence_type == "checkpoint":
        if payload.get("run_id") != run_card.get("run_id"):
            issues.append(
                f"{entry_label} checkpoint run_id mismatch: {evidence_path_ref}"
            )
        if "status" not in payload:
            issues.append(
                f"{entry_label} checkpoint missing status: {evidence_path_ref}"
            )
        return issues

    required_keys = EVIDENCE_TYPE_JSON_KEYS.get(evidence_type)
    if required_keys and not any(key in payload for key in required_keys):
        issues.append(
            f"{entry_label} does not match claimed type {evidence_type}: {evidence_path_ref}"
        )

    return issues


