"""RAE-specific execution helpers for autonomous outcome evaluation."""

import json
import pathlib
from typing import Any

from lib import outcome_eval as core


def _prepare_rae_workspace(workspace: pathlib.Path, task_id: str) -> dict[str, Any] | None:
    for argv in (
        ["git", "init", "-q", str(workspace)],
        ["git", "-C", str(workspace), "config", "user.name", "RAE Eval"],
        ["git", "-C", str(workspace), "config", "user.email", "rae-eval@example.invalid"],
        ["git", "-C", str(workspace), "add", "."],
        ["git", "-C", str(workspace), "commit", "-qm", "fixture baseline"],
    ):
        setup = core.run_command(argv, cwd=workspace)
        if setup["returncode"] != 0:
            return {
                "task_id": task_id,
                "verdict": "fail",
                "failure_classes": ["missing_evidence"],
                "setup": setup,
            }
    return None


def _rae_candidate(
    workspace: pathlib.Path, task: dict[str, Any], policy_path: pathlib.Path
) -> dict[str, Any]:
    return core.run_command(
        [
            "bash",
            str(pathlib.Path(__file__).resolve().parents[3] / "scripts/rae.sh"),
            "agent",
            "run",
            "--project-root",
            str(workspace),
            "--task",
            task["task_prompt"],
            "--policy",
            str(policy_path),
            "--json",
        ],
        cwd=workspace,
        timeout_seconds=1800,
    )


def _candidate_payload(candidate: dict[str, Any]) -> dict[str, Any] | None:
    try:
        payload = json.loads(candidate["stdout"])
    except (TypeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _rae_worktree(
    workspace: pathlib.Path, payload: dict[str, Any] | None
) -> tuple[pathlib.Path, bool]:
    expected_root = (workspace / ".git" / "rae-worktrees").resolve()
    worktree_value = payload.get("workspace_root") if payload else None
    worktree = (
        pathlib.Path(worktree_value).resolve() if isinstance(worktree_value, str) else workspace
    )
    return worktree, worktree.is_dir() and worktree.is_relative_to(expected_root)


def _candidate_failure_classes(
    candidate: dict[str, Any], payload: dict[str, Any] | None, worktree_is_trusted: bool
) -> list[str]:
    failures: list[str] = []
    if payload is None:
        failures.append("missing_evidence")
    if candidate["returncode"] != 0:
        failures.append("timeout" if candidate.get("timed_out") else "candidate_failed")
    if not payload or payload.get("success") is not True or not worktree_is_trusted:
        failures.append("missing_evidence")
    return failures


def _workspace_changes(
    task: dict[str, Any], worktree: pathlib.Path, trusted: bool, before: dict[str, bytes]
) -> tuple[list[str], list[str], list[str]]:
    changes = core.changed_paths(worktree, before) if trusted else []
    failures = core._scope_failures(task, worktree, changes, before) if trusted else []
    unsafe_paths = core._unsafe_changed_paths(worktree, changes) if trusted else []
    if unsafe_paths:
        failures.append("unsafe_file_type")
    return failures, changes, unsafe_paths


def _rae_failures(
    task: dict[str, Any],
    candidate: dict[str, Any],
    payload: dict[str, Any] | None,
    worktree: pathlib.Path,
    worktree_is_trusted: bool,
    before: dict[str, bytes],
) -> tuple[list[str], list[str], list[str], dict[str, Any], dict[str, Any]]:
    failures = _candidate_failure_classes(candidate, payload, worktree_is_trusted)
    workspace_failures, changes, unsafe_paths = _workspace_changes(
        task, worktree, worktree_is_trusted, before
    )
    failures.extend(workspace_failures)
    verifier, verifier_failures = core._rae_verifier(
        worktree, task, worktree_is_trusted, unsafe_paths
    )
    failures.extend(verifier_failures)
    if verifier["returncode"] != 0 and "verification_failed" not in failures:
        failures.append("verification_failed")
    resource_usage = core.trace_resource_usage(worktree, payload if worktree_is_trusted else None)
    if resource_usage["measurement_status"] != "complete":
        failures.append("incomplete_resource_measurement")
    return failures, changes, unsafe_paths, verifier, resource_usage


def run_rae_outcome_task(
    *,
    task: dict[str, Any],
    fixture_root: pathlib.Path,
    workspace: pathlib.Path,
    policy_path: pathlib.Path,
) -> dict[str, Any]:
    """Run the fixed RAE entrypoint before the closed trusted judge."""
    core.validate_outcome_task(task)
    core.copy_fixture(fixture_root, workspace)
    setup_failure = _prepare_rae_workspace(workspace, task["task_id"])
    if setup_failure is not None:
        return setup_failure
    before = core.snapshot_files(workspace)
    candidate = _rae_candidate(workspace, task, policy_path)
    payload = _candidate_payload(candidate)
    worktree, worktree_is_trusted = _rae_worktree(workspace, payload)
    failures, changes, unsafe_paths, verifier, resource_usage = _rae_failures(
        task, candidate, payload, worktree, worktree_is_trusted, before
    )
    return {
        "task_id": task["task_id"],
        "split": task["split"],
        "verdict": "pass" if not failures else "fail",
        "failure_classes": sorted(set(failures)),
        "changed_paths": changes,
        "unsafe_paths": unsafe_paths,
        "candidate": candidate,
        "verifier": verifier,
        "workspace_root": str(worktree),
        "judge_case_id": task["judge_case_id"],
        "resource_usage": resource_usage,
    }
