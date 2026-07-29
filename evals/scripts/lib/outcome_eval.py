"""Hermetic autonomous-code-change benchmark helpers.

Task data names a trusted judge case; it never contains a shell command.  The
caller supplies the candidate runner as an argv vector, so this module is also
usable with deterministic fakes in tests.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Sequence
from typing import Any

from common import ROOT, dump_json, is_within_directory, repo_relpath, run_command

from lib.outcome_resources import measured_resource_total, trace_events, unavailable_resource_usage


def _python_compile(workspace: pathlib.Path, task: dict[str, Any]) -> list[str]:
    return [
        sys.executable,
        "-S",
        "-B",
        "-c",
        "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], 'exec')",
        str(workspace / task["target_path"]),
    ]


def _python_unittest(workspace: pathlib.Path, _task: dict[str, Any]) -> list[str]:
    return [sys.executable, "-S", "-B", "-m", "unittest", "discover", "-s", "tests", "-v"]


JUDGE_CASES = {
    "python-compile": _python_compile,
    "python-unittest": _python_unittest,
}
TASK_KEYS = frozenset(
    {
        "task_id",
        "split",
        "fixture_id",
        "task_prompt",
        "target_path",
        "allowed_paths",
        "forbidden_paths",
        "judge_case_id",
    }
)
HARD_FAILURE_CLASSES = frozenset(
    {
        "candidate_failed",
        "verification_failed",
        "scope_violation",
        "forbidden_deletion",
        "missing_evidence",
        "timeout",
        "incomplete_resource_measurement",
        "budget_exceeded",
        "evaluator_integrity_drift",
        "unsafe_file_type",
        "evaluator_safety_failure",
    }
)

OUTCOME_REPORT_TYPE = "autonomous-outcome-report"
OUTCOME_COMPARISON_TYPE = "autonomous-outcome-comparison"
MAX_TASK_PROMPT_BYTES = 32 * 1024
_EVALUATOR_FILES = (
    "evals/schemas/outcome-task-spec.schema.json",
    "evals/schemas/outcome-task-bundle.schema.json",
    "evals/schemas/outcome-report.schema.json",
    "evals/schemas/outcome-comparison.schema.json",
    "evals/scripts/lib/outcome_eval.py",
    "evals/scripts/lib/outcome_comparison.py",
    "evals/scripts/lib/outcome_rae.py",
    "evals/scripts/lib/outcome_resources.py",
    "evals/scripts/lib/policy_optimizer.py",
    "evals/scripts/lib/policy_optimizer_evidence.py",
    "evals/scripts/lib/policy_optimizer_policy.py",
    "evals/scripts/run_outcome_benchmark.py",
    "evals/scripts/compare_outcome_reports.py",
    "evals/scripts/optimize_harness.py",
)


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def evaluator_manifest_digest(manifest: dict[str, str]) -> str:
    return canonical_digest(dict(sorted(manifest.items())))


def _fixture_manifest_paths(
    tasks: Sequence[dict[str, Any]], fixture_root: pathlib.Path
) -> set[pathlib.Path]:
    paths: set[pathlib.Path] = set()
    for task in tasks:
        fixture = (fixture_root / task["fixture_id"]).resolve()
        if not is_within_directory(fixture, ROOT) or not fixture.is_dir():
            raise ValueError(f"fixture directory is not trusted: {task['fixture_id']}")
        for path in fixture.rglob("*"):
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise ValueError(f"fixture contains an unsafe file type: {path}")
            paths.add(path.resolve())
    return paths


def _manifest_entry(path: pathlib.Path) -> tuple[str, str]:
    if not is_within_directory(path, ROOT) or not path.is_file():
        raise ValueError(f"evaluator manifest path is missing or outside the repository: {path}")
    return path.relative_to(ROOT).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()


def build_evaluator_manifest(
    *, bundle_path: pathlib.Path, tasks: Sequence[dict[str, Any]], fixture_root: pathlib.Path
) -> dict[str, str]:
    """Hash evaluator code, full task contracts, and every referenced fixture file."""
    paths = {ROOT / relative for relative in _EVALUATOR_FILES}
    paths.add(bundle_path.resolve())
    paths.update(_fixture_manifest_paths(tasks, fixture_root))
    return dict(_manifest_entry(path) for path in sorted(paths, key=str))


def trusted_judge_argv(workspace: pathlib.Path, task: dict[str, Any]) -> list[str]:
    """Build argv from a closed judge registry, not from benchmark task input."""
    judge_case_id = task.get("judge_case_id")
    if not isinstance(judge_case_id, str):
        raise ValueError(f"unknown trusted judge_case_id: {judge_case_id}")
    builder = JUDGE_CASES.get(judge_case_id)
    if builder is None:
        raise ValueError(f"unknown trusted judge_case_id: {judge_case_id}")
    return builder(workspace, task)


def _seatbelt_literal(value: pathlib.Path) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _seatbelt_profile(workspace: pathlib.Path, scratch: pathlib.Path) -> str:
    executable = pathlib.Path(sys.executable).resolve()
    read_paths = {
        workspace.resolve(),
        scratch.resolve(),
        executable,
        pathlib.Path(sys.executable),
        pathlib.Path("/System/Library"),
        pathlib.Path("/usr/lib"),
        pathlib.Path("/private/var/db/dyld"),
    }
    for entry in sys.path:
        candidate = pathlib.Path(entry)
        if candidate.is_absolute() and str(candidate).startswith(
            ("/opt/homebrew/", "/usr/", "/System/", "/Library/Apple/")
        ):
            read_paths.add(candidate.resolve())
    readable = " ".join(
        f"(subpath {_seatbelt_literal(path)})" for path in sorted(read_paths, key=str)
    )
    executables = " ".join(
        f"(literal {_seatbelt_literal(path)})"
        for path in sorted({executable, pathlib.Path(sys.executable)}, key=str)
    )
    return " ".join(
        (
            "(version 1)",
            "(deny default)",
            "(allow process-fork)",
            f"(allow process-exec {executables})",
            "(allow sysctl-read)",
            f'(allow file-read* {readable} (literal "/dev/null") (literal "/dev/urandom"))',
            f"(allow file-write* (subpath {_seatbelt_literal(scratch.resolve())}))",
            "(deny network*)",
        )
    )


def _judge_environment(scratch: pathlib.Path) -> dict[str, str]:
    home = scratch / "home"
    cache = scratch / "pycache"
    home.mkdir(mode=0o700)
    cache.mkdir(mode=0o700)
    return {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPYCACHEPREFIX": str(cache),
        "TMPDIR": str(scratch),
    }


def _unavailable_judge_result(
    workspace: pathlib.Path, judge_argv: list[str], reason: str
) -> dict[str, Any]:
    return {
        "argv": judge_argv,
        "cwd": repo_relpath(workspace),
        "returncode": 126,
        "stdout": "",
        "stderr": reason,
        "duration_seconds": 0.0,
        "timed_out": False,
        "timeout_seconds": 30,
        "sandbox": {"backend": None, "enforced": False, "reason": reason},
    }


def _sandbox_is_trusted(sandbox_exec: pathlib.Path) -> bool:
    try:
        sandbox_stat = sandbox_exec.lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(sandbox_stat.st_mode)
        and not sandbox_exec.is_symlink()
        and sandbox_stat.st_uid == 0
        and not sandbox_stat.st_mode & stat.S_IWOTH
    )


def _sandbox_result(
    workspace: pathlib.Path,
    judge_argv: list[str],
    sandbox_exec: pathlib.Path,
    timeout_seconds: float,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix=".rae-judge-", dir=workspace.parent) as scratch_value:
        scratch = pathlib.Path(scratch_value)
        result = run_command(
            [str(sandbox_exec), "-p", _seatbelt_profile(workspace, scratch), *judge_argv],
            cwd=workspace,
            env=_judge_environment(scratch),
            timeout_seconds=timeout_seconds,
        )
    startup_failed = result.get("returncode") in {64, 65, 71, 78} and "sandbox-exec:" in result.get(
        "stderr", ""
    )
    result["argv"] = judge_argv
    result["sandbox"] = {
        "backend": "macos-seatbelt",
        "enforced": not startup_failed,
        "reason": "sandbox initialization failed"
        if startup_failed
        else "default-deny profile applied",
        "network": "denied",
        "workspace_access": "read-only",
        "scratch_access": "read-write",
        "ambient_environment": "cleared",
    }
    return result


def run_trusted_judge(
    workspace: pathlib.Path, task: dict[str, Any], *, timeout_seconds: float = 30
) -> dict[str, Any]:
    """Execute model-written code only inside an evaluator-owned OS sandbox."""
    judge_argv = trusted_judge_argv(workspace, task)
    if sys.platform != "darwin":
        return _unavailable_judge_result(
            workspace,
            judge_argv,
            "trusted judge sandbox is unavailable on this platform; no candidate code was executed",
        )
    sandbox_exec = pathlib.Path("/usr/bin/sandbox-exec")
    if not _sandbox_is_trusted(sandbox_exec):
        return _unavailable_judge_result(
            workspace,
            judge_argv,
            "trusted /usr/bin/sandbox-exec failed ownership or file-type validation; "
            "no candidate code was executed",
        )
    return _sandbox_result(workspace, judge_argv, sandbox_exec, timeout_seconds)


def evaluator_safety_failure(verifier: dict[str, Any]) -> bool:
    sandbox = verifier.get("sandbox")
    if not isinstance(sandbox, dict) or sandbox.get("enforced") is not True:
        return True
    stderr = str(verifier.get("stderr", "")).lower()
    return "operation not permitted" in stderr or "sandbox violation" in stderr


def _safe_task_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._/-]+", value):
        raise ValueError(f"{label} must be a repository-relative path")
    normalized = pathlib.PurePosixPath(value)
    if (
        normalized.is_absolute()
        or normalized.as_posix() != value
        or ".." in normalized.parts
        or value in {".", ".git", ".pipeline"}
        or value.startswith((".git/", ".pipeline/"))
    ):
        raise ValueError(f"{label} must be a normalized non-runtime repository path")
    return value


def _validate_task_identifiers(task: dict[str, Any]) -> None:
    if not isinstance(task, dict) or set(task) != TASK_KEYS:
        raise ValueError("outcome task must contain exactly the documented fields")
    for field in ("task_id", "fixture_id"):
        value = task[field]
        if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", value):
            raise ValueError(f"{field} must be a lowercase identifier")
    if task["split"] not in {"dev", "held-out", "stress", "ablation"}:
        raise ValueError("task split is invalid")


def _validate_task_prompt(task: dict[str, Any]) -> None:
    prompt = task["task_prompt"]
    if (
        not isinstance(prompt, str)
        or not prompt.strip()
        or len(prompt.encode("utf-8")) > MAX_TASK_PROMPT_BYTES
    ):
        raise ValueError("task_prompt must be non-empty and at most 32 KiB")


def _validated_task_paths(task: dict[str, Any]) -> tuple[str, dict[str, list[str]]]:
    target = _safe_task_path(task["target_path"], "target_path")
    path_sets: dict[str, list[str]] = {}
    for field in ("allowed_paths", "forbidden_paths"):
        values = task[field]
        if not isinstance(values, list) or (field == "allowed_paths" and not values):
            qualifier = "non-empty " if field == "allowed_paths" else ""
            raise ValueError(f"{field} must be a {qualifier}list")
        normalized = [_safe_task_path(value, field) for value in values]
        if len(normalized) != len(set(normalized)):
            raise ValueError(f"{field} must not contain duplicates")
        path_sets[field] = normalized
    return target, path_sets


def validate_outcome_task(task: dict[str, Any]) -> None:
    """Reject malformed task data before it can select a fixture or judge."""
    _validate_task_identifiers(task)
    _validate_task_prompt(task)
    target, path_sets = _validated_task_paths(task)
    if target not in path_sets["allowed_paths"]:
        raise ValueError("target_path must be present in allowed_paths")
    if set(path_sets["allowed_paths"]) & set(path_sets["forbidden_paths"]):
        raise ValueError("allowed_paths and forbidden_paths must be disjoint")
    if task["judge_case_id"] not in JUDGE_CASES:
        raise ValueError(f"unknown trusted judge_case_id: {task['judge_case_id']}")


def copy_fixture(fixture_root: pathlib.Path, workspace: pathlib.Path) -> None:
    for path in fixture_root.rglob("*"):
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError(f"fixture contains an unsafe file type: {path}")
    if workspace.exists():
        shutil.rmtree(workspace)
    shutil.copytree(fixture_root, workspace)


def changed_paths(workspace: pathlib.Path, before: dict[str, bytes]) -> list[str]:
    after = snapshot_files(workspace)
    return sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))


def snapshot_files(workspace: pathlib.Path) -> dict[str, bytes]:
    snapshot: dict[str, bytes] = {}
    for path in workspace.rglob("*"):
        relative = path.relative_to(workspace).as_posix()
        if relative == "outcome-result.json" or relative.startswith((".git/", ".pipeline/")):
            continue
        mode = path.lstat().st_mode
        if stat.S_ISREG(mode):
            snapshot[relative] = path.read_bytes()
        elif stat.S_ISLNK(mode):
            snapshot[relative] = f"symlink:{path.readlink()}".encode()
        elif not stat.S_ISDIR(mode):
            snapshot[relative] = f"special:{stat.S_IFMT(mode)}".encode()
    return snapshot


def _unsafe_changed_paths(workspace: pathlib.Path, changes: list[str]) -> list[str]:
    unsafe: list[str] = []
    for relative in changes:
        path = workspace / relative
        if path.is_symlink():
            unsafe.append(relative)
            continue
        if path.exists() and not stat.S_ISREG(path.lstat().st_mode):
            unsafe.append(relative)
    return unsafe


def _record_resource_usage(calls: list[dict[str, Any]]) -> dict[str, Any]:
    usage: dict[str, Any] = {"agent_calls": len(calls), "max_parallelism": 1}
    missing: list[str] = []
    for output_field, event_field, scale in (
        ("agent_duration_seconds", "duration_ms", 0.001),
        ("input_tokens", "tokens_in", 1),
        ("output_tokens", "tokens_out", 1),
    ):
        value = measured_resource_total(calls, event_field, scale)
        if value is None:
            missing.append(output_field)
        else:
            usage[output_field] = value
    usage["measurement_status"] = (
        "complete" if not missing else ("partial" if calls else "unavailable")
    )
    usage["missing_measurements"] = missing
    return usage


def trace_resource_usage(worktree: pathlib.Path, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Aggregate provider measurements without turning missing values into zeroes."""
    run_id = payload.get("run_id") if isinstance(payload, dict) else None
    trace_path = worktree / ".pipeline" / "runs" / str(run_id) / "trace.jsonl"
    if not isinstance(run_id, str) or not trace_path.is_file():
        return unavailable_resource_usage()
    events = trace_events(trace_path)
    if events is None:
        return unavailable_resource_usage()
    calls = [event for event in events if event.get("event") == "agent_call"]
    return _record_resource_usage(calls)


def _scope_failures(
    task: dict[str, Any], workspace: pathlib.Path, changes: list[str], before: dict[str, bytes]
) -> list[str]:
    allowed = set(task.get("allowed_paths", []))
    forbidden = set(task.get("forbidden_paths", []))
    failures: list[str] = []
    if any(path not in allowed for path in changes):
        failures.append("scope_violation")
    if any(
        path in forbidden and path in before and not (workspace / path).exists() for path in changes
    ):
        failures.append("forbidden_deletion")
    return failures


def _candidate_failure_class(candidate: dict[str, Any]) -> str | None:
    if candidate["returncode"] == 0:
        return None
    return "timeout" if candidate.get("timed_out") else "candidate_failed"


def _outcome_verifier(
    workspace: pathlib.Path, task: dict[str, Any], unsafe_paths: list[str]
) -> tuple[dict[str, Any], list[str]]:
    if unsafe_paths:
        return {"returncode": 1, "skipped": "unsafe candidate file type"}, ["unsafe_file_type"]
    verifier = run_trusted_judge(workspace, task)
    failures = ["evaluator_safety_failure"] if evaluator_safety_failure(verifier) else []
    if verifier["returncode"] != 0:
        failures.append("verification_failed")
    return verifier, failures


def run_outcome_task(
    *,
    task: dict[str, Any],
    fixture_root: pathlib.Path,
    workspace: pathlib.Path,
    candidate_runner_argv: Sequence[str],
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Run a candidate against a copied fixture and fixed trusted verifier."""
    validate_outcome_task(task)
    if not candidate_runner_argv:
        raise ValueError("candidate_runner_argv must not be empty")
    copy_fixture(fixture_root, workspace)
    before = snapshot_files(workspace)
    candidate = run_command(
        [*candidate_runner_argv, "--workspace", str(workspace), "--task-id", task["task_id"]],
        cwd=workspace,
        timeout_seconds=timeout_seconds,
    )
    changes = changed_paths(workspace, before)
    failures = [failure for failure in [_candidate_failure_class(candidate)] if failure]
    failures.extend(_scope_failures(task, workspace, changes, before))
    unsafe_paths = _unsafe_changed_paths(workspace, changes)
    verifier, verifier_failures = _outcome_verifier(workspace, task, unsafe_paths)
    failures.extend(verifier_failures)
    result = {
        "task_id": task["task_id"],
        "verdict": "pass" if not failures else "fail",
        "failure_classes": sorted(set(failures)),
        "changed_paths": changes,
        "unsafe_paths": unsafe_paths,
        "candidate": candidate,
        "verifier": verifier,
        "judge_case_id": task["judge_case_id"],
    }
    dump_json(workspace / "outcome-result.json", result)
    return result


def _rae_verifier(
    workspace: pathlib.Path, task: dict[str, Any], trusted: bool, unsafe_paths: list[str]
) -> tuple[dict[str, Any], list[str]]:
    if not trusted:
        return {"returncode": 1, "skipped": "unsafe or untrusted candidate workspace"}, []
    return _outcome_verifier(workspace, task, unsafe_paths)


def _aggregate_resource_usage(records: list[Any]) -> tuple[bool, dict[str, Any]]:
    complete_records = _complete_usage_records(records)
    if complete_records is None:
        return False, {
            "measurement_status": "incomplete",
            "missing_measurements": ["one_or_more_task_attempts"],
        }
    return True, {
        "measurement_status": "complete",
        "missing_measurements": [],
        "agent_duration_seconds": round(
            sum(float(usage["agent_duration_seconds"]) for usage in complete_records), 4
        ),
        "input_tokens": sum(int(usage["input_tokens"]) for usage in complete_records),
        "output_tokens": sum(int(usage["output_tokens"]) for usage in complete_records),
        "agent_calls": sum(int(usage["agent_calls"]) for usage in complete_records),
        "max_parallelism": max(int(usage["max_parallelism"]) for usage in complete_records),
    }


def _outcome_hard_failures(outcomes: list[dict[str, Any]]) -> list[str]:
    return sorted(
        {
            failure
            for result in outcomes
            for failure in result.get("failure_classes", [])
            if failure in HARD_FAILURE_CLASSES
        }
    )


def aggregate_repeats(repeats: Sequence[Sequence[dict[str, Any]]]) -> dict[str, Any]:
    """Aggregate independently executed repeats without hiding hard failures."""
    outcomes = [result for repeat in repeats for result in repeat]
    task_count = len(outcomes)
    passes = sum(result["verdict"] == "pass" for result in outcomes)
    hard_failures = _outcome_hard_failures(outcomes)
    usage_complete, resource_usage = _aggregate_resource_usage(
        [result.get("resource_usage") for result in outcomes]
    )
    return {
        "repeat_count": len(repeats),
        "task_attempt_count": task_count,
        "success_rate": round(passes / task_count, 4) if task_count else 0.0,
        "hard_failure_classes": hard_failures,
        "complete": usage_complete,
        "resource_usage": resource_usage,
        "status": "pass" if not hard_failures and passes == task_count else "fail",
    }


def _complete_usage_records(records: list[Any]) -> list[dict[str, Any]] | None:
    if not records or not all(isinstance(record, dict) for record in records):
        return None
    typed_records = [record for record in records if isinstance(record, dict)]
    if any(record.get("measurement_status") != "complete" for record in typed_records):
        return None
    return typed_records


def task_matrix_digest(
    repeats: Sequence[Sequence[dict[str, Any]]], evaluator_digest: str | None = None
) -> str:
    """Bind evidence to the exact repeat/task matrix without including outcomes."""
    matrix: list[dict[str, Any]] = []
    for repeat_index, repeat in enumerate(repeats):
        task_ids: list[str] = []
        for result in repeat:
            task_id = result.get("task_id")
            if not isinstance(task_id, str) or not task_id:
                raise ValueError("outcome repeat contains an invalid task_id")
            task_ids.append(task_id)
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("outcome repeat contains duplicate task IDs")
        matrix.append({"repeat": repeat_index, "task_ids": sorted(task_ids)})
    return canonical_digest(
        {"evaluator_manifest_digest": evaluator_digest, "repeat_task_matrix": matrix}
    )


# Compatibility exports are imported after this module's shared helpers to avoid cycles.
from lib.outcome_comparison import compare_outcome_reports  # noqa: E402, F401
from lib.outcome_rae import run_rae_outcome_task  # noqa: E402, F401
