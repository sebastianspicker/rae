#!/usr/bin/env python3
"""Shared helpers for the umbrella eval and routing harness."""

import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import uuid
from contextlib import suppress
from datetime import UTC, date, datetime
from typing import Any, TypeAlias, cast

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EVALS = ROOT / "evals"
RESULTS_ROOT = EVALS / "results"
ORCHESTRATION_ROOT = ROOT / "packages" / "orchestration"


def _resolve_trusted_executables() -> dict[str, pathlib.Path]:
    """Resolve the small executable allowlist once, before caller-provided env changes."""
    python = pathlib.Path(sys.executable).resolve()
    trusted = {
        "python": python,
        "python3": python,
        pathlib.Path(sys.executable).name: python,
    }
    for name in ("node", "bash", "git", "sandbox-exec"):
        executable = shutil.which(name)
        if executable is not None:
            trusted[name] = pathlib.Path(executable).resolve()
    return trusted


_TRUSTED_EXECUTABLES = _resolve_trusted_executables()

JsonScalar: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


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


def _coerce_subprocess_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    raise RuntimeError("subprocess returned malformed non-text output")


def _find_package_root(cwd: pathlib.Path) -> pathlib.Path:
    current = cwd.resolve()
    while True:
        if (current / "package.json").is_file():
            return current
        if current == current.parent:
            raise ValueError("node commands require a cwd beneath a package root")
        current = current.parent


def _resolve_trusted_executable(
    requested: str, env: dict[str, str] | None
) -> tuple[str, pathlib.Path]:
    alias = pathlib.Path(requested).name
    trusted = _TRUSTED_EXECUTABLES.get(alias)
    if trusted is None:
        raise ValueError(f"unsupported executable: {requested}")
    if pathlib.Path(requested).is_absolute():
        return alias, _validate_trusted_absolute_path(requested, trusted)
    _validate_executable_alias(requested, alias)
    _validate_visible_executable(alias, trusted, env)
    return alias, trusted


def _validate_trusted_absolute_path(requested: str, trusted: pathlib.Path) -> pathlib.Path:
    if pathlib.Path(requested).resolve() != trusted:
        raise ValueError(f"untrusted executable path: {requested}")
    return trusted


def _validate_executable_alias(requested: str, alias: str) -> None:
    if requested != alias:
        raise ValueError(
            f"executable must be an allowlisted name or trusted absolute path: {requested}"
        )


def _validate_visible_executable(
    alias: str, trusted: pathlib.Path, env: dict[str, str] | None
) -> None:
    effective_path = (env or os.environ).get("PATH")
    visible = shutil.which(alias, path=effective_path) if effective_path else None
    if visible is None or pathlib.Path(visible).resolve() != trusted:
        raise ValueError(f"PATH-shadowed or unavailable executable: {alias}")


def _resolve_node_entrypoint(prepared: list[str], cwd: pathlib.Path) -> None:
    if len(prepared) < 2 or prepared[1].startswith("-"):
        raise ValueError("node commands require a package-confined entrypoint")
    package_root = _find_package_root(cwd)
    entrypoint = pathlib.Path(prepared[1])
    if not entrypoint.is_absolute():
        entrypoint = cwd / entrypoint
    entrypoint = entrypoint.resolve(strict=True)
    try:
        entrypoint.relative_to(package_root)
    except ValueError as exc:
        raise ValueError("node entrypoint must resolve below the package root") from exc
    prepared[1] = str(entrypoint)


def _prepare_command(argv: list[str], cwd: pathlib.Path, env: dict[str, str] | None) -> list[str]:
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("argv must be a non-empty list of strings")
    if any("\x00" in arg for arg in argv):
        raise ValueError("argv must not contain NUL bytes")

    alias, trusted = _resolve_trusted_executable(argv[0], env)
    prepared = [str(trusted), *argv[1:]]
    if alias == "node":
        _resolve_node_entrypoint(prepared, cwd)
    return prepared


def run_command(
    argv: list[str],
    *,
    cwd: pathlib.Path | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: float | None = 300.0,
) -> dict[str, Any]:
    """Run a local command and return the transcript as benchmark evidence."""
    requested_argv = list(argv)
    command_cwd = (cwd or ROOT).resolve()
    prepared_argv = _prepare_command(argv, command_cwd, env)
    started = time.monotonic()
    process: subprocess.Popen[str] | None = None
    try:
        # Commands come from repository-owned benchmark metadata and are
        # intentionally executed as argument vectors without a shell.
        process = subprocess.Popen(  # nosec B603
            prepared_argv,
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
            requested_argv,
            command_cwd,
            stdout,
            stderr,
            started,
            timeout_seconds,
            termination,
        )

    if process is None:
        raise RuntimeError("command process was not created")
    return {
        "argv": requested_argv,
        "cwd": repo_relpath(command_cwd),
        "returncode": process.returncode,
        "stdout": _coerce_subprocess_output(stdout),
        "stderr": _coerce_subprocess_output(stderr),
        "duration_seconds": round(time.monotonic() - started, 4),
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
