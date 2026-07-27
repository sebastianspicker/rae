#!/usr/bin/env python3
"""Shared helpers for the umbrella eval and routing harness."""

import json
import os
import pathlib
import signal
import subprocess
import time
import uuid
from contextlib import suppress
from datetime import UTC, date, datetime
from typing import Any, cast

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EVALS = ROOT / "evals"
RESULTS_ROOT = EVALS / "results"

type JsonScalar = None | bool | int | float | str
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]


def _nearest_existing_ancestor(path: pathlib.Path) -> pathlib.Path:
    """Find the deepest existing path before resolving containment checks."""
    current = path.resolve(strict=False)
    while not current.exists() and current != current.parent:
        current = current.parent
    return current


def is_within_directory(path: pathlib.Path, root: pathlib.Path) -> bool:
    """Check containment for paths that may not exist yet."""
    resolved_root = root.resolve()
    resolved_path = path.resolve(strict=False)
    current = _nearest_existing_ancestor(resolved_path)
    while True:
        try:
            if current.samefile(resolved_root):
                return True
        except FileNotFoundError:
            pass
        if current == current.parent:
            return False
        current = current.parent


def relative_to_directory(path: pathlib.Path, root: pathlib.Path) -> pathlib.Path:
    """Return a relative path after proving it cannot escape root."""
    resolved_root = root.resolve()
    resolved_path = path.resolve(strict=False)
    current = _nearest_existing_ancestor(resolved_path)
    while True:
        try:
            if current.samefile(resolved_root):
                return resolved_path.relative_to(current)
        except FileNotFoundError:
            pass
        if current == current.parent:
            raise ValueError(f"{resolved_path} is outside {resolved_root}")
        current = current.parent


def now_utc() -> datetime:
    return datetime.now(UTC)


def iso_timestamp() -> str:
    return now_utc().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today_iso() -> str:
    return date.today().isoformat()


def new_run_id(prefix: str) -> str:
    suffix = uuid.uuid4().hex[:12]
    return f"{prefix}-{today_iso()}-{suffix}"


def load_json_value(path: pathlib.Path) -> JsonValue:
    return cast(JsonValue, json.loads(path.read_text(encoding="utf-8")))


def load_json(path: pathlib.Path) -> Any:
    """Compatibility loader for callers that validate their own JSON shape."""
    return load_json_value(path)


def load_json_object(path: pathlib.Path) -> JsonObject:
    data = load_json_value(path)
    if not isinstance(data, dict):
        raise ValueError(f"{repo_relpath(path)} must be a JSON object")
    return data


def dump_json(path: pathlib.Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def append_jsonl(path: pathlib.Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=False) + "\n")


def resolve_metadata_path(
    value: object,
    *,
    label: str,
    contained_by: pathlib.Path = ROOT,
    must_exist: bool = False,
) -> pathlib.Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty repository-relative path")
    candidate = pathlib.Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"{label} must be repository-relative")
    resolved = (ROOT / candidate).resolve(strict=False)
    if not is_within_directory(resolved, contained_by):
        raise ValueError(f"{label} must point under {repo_relpath(contained_by)}")
    if must_exist and not resolved.exists():
        raise ValueError(f"{label} points to a missing path")
    return resolved


COMMAND_TERMINATION_GRACE_SECONDS = 1.0


def _timeout_result(
    argv: list[str],
    cwd: pathlib.Path,
    stdout: str,
    stderr: str,
    started: float,
    timeout_seconds: float | None,
    termination: str,
) -> dict[str, Any]:
    timeout_label = (
        f"{timeout_seconds:g}" if isinstance(timeout_seconds, (int, float)) else "unknown"
    )
    message = f"command timed out after {timeout_label}s; process group {termination}"
    return {
        "argv": argv,
        "cwd": repo_relpath(cwd),
        "returncode": 124,
        "stdout": stdout,
        "stderr": f"{stderr.rstrip()}\n{message}".strip(),
        "duration_seconds": round(time.monotonic() - started, 4),
        "timed_out": True,
        "timeout_seconds": timeout_seconds,
        "containment": {
            "status": "uncertain",
            "scope": "process-group",
            "reason": "a descendant that created a new session cannot be proven terminated",
        },
    }


def _text_output(value: str | bytes | None) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return ""


def _terminate_process_group(process: subprocess.Popen[str]) -> tuple[str, str, str]:
    """Bound a timed-out command and every child it started in its session."""
    if os.name != "posix":
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=COMMAND_TERMINATION_GRACE_SECONDS)
            return stdout, stderr, "terminated"
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
            return stdout, stderr, "killed after bounded termination grace"

    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        stdout, stderr = process.communicate(timeout=COMMAND_TERMINATION_GRACE_SECONDS)
        return stdout, stderr, "terminated"
    except subprocess.TimeoutExpired:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        return stdout, stderr, "killed after bounded termination grace"


def run_command(
    argv: list[str],
    *,
    cwd: pathlib.Path | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: float | None = 300.0,
) -> dict[str, Any]:
    """Run a local command and return the transcript as benchmark evidence."""
    started = time.monotonic()
    command_cwd = cwd or ROOT
    process: subprocess.Popen[str] | None = None
    try:
        # Commands come from repository-owned benchmark metadata and are
        # intentionally executed as argument vectors without a shell.
        process = subprocess.Popen(  # noqa: S603
            argv,
            cwd=command_cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        if process is None:
            raise RuntimeError("command timed out before its process was created") from exc
        stdout, stderr, termination = _terminate_process_group(process)
        # ``communicate`` returns complete stream contents after termination;
        # retain TimeoutExpired output only if the platform provided no stream.
        stdout = stdout or _text_output(exc.stdout)
        stderr = stderr or _text_output(exc.stderr)
        return _timeout_result(
            argv,
            command_cwd,
            stdout,
            stderr,
            started,
            timeout_seconds,
            termination,
        )

    duration = round(time.monotonic() - started, 4)
    return {
        "argv": argv,
        "cwd": repo_relpath(command_cwd),
        "returncode": process.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "duration_seconds": duration,
        "timed_out": False,
        "timeout_seconds": timeout_seconds,
    }


def repo_relpath(path: pathlib.Path) -> str:
    rel = relative_to_directory(path, ROOT)
    return "." if rel == pathlib.Path(".") else rel.as_posix()


def default_system_metadata(runtime: str) -> dict[str, str]:
    return {
        "model": "rule-based-router-v1",
        "runtime": runtime,
        "tool_adapter": "local-shell",
        "runtime_version": "v1",
        "reasoning_effort": "deterministic",
    }


def metric_ratio(numerator: int, denominator: int) -> float:
    if denominator == 0:
        return 1.0
    return round(numerator / denominator, 4)


def path_exists(path_str: str) -> bool:
    try:
        resolve_metadata_path(path_str, label="path", must_exist=True)
    except ValueError:
        return False
    return True


def sanitize_env(extra_env: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return env
