#!/usr/bin/env python3
"""Shared helpers for the umbrella eval and routing harness."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time
import uuid
from datetime import UTC, date, datetime
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EVALS = ROOT / "evals"
RESULTS_ROOT = EVALS / "results"


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


def load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(path: pathlib.Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )


def append_jsonl(path: pathlib.Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=False) + "\n")


def ensure_relative_to_root(path: pathlib.Path) -> str:
    try:
        rel = relative_to_directory(path, ROOT)
        return "." if rel == pathlib.Path(".") else rel.as_posix()
    except ValueError:
        return str(path.resolve(strict=False))


def relative_to_root(input_path: str | pathlib.Path) -> str:
    return ensure_relative_to_root(pathlib.Path(input_path))


def run_command(
    argv: list[str],
    *,
    cwd: pathlib.Path | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: float | None = 300.0,
) -> dict[str, Any]:
    """Run a local command and return the transcript as benchmark evidence."""
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd or ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        duration = round(time.monotonic() - started, 4)
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        timeout_label = (
            f"{timeout_seconds:g}"
            if isinstance(timeout_seconds, (int, float))
            else "unknown"
        )
        message = f"command timed out after {timeout_label}s"
        return {
            "argv": argv,
            "cwd": relative_to_root(cwd or ROOT),
            "returncode": 124,
            "stdout": stdout,
            "stderr": f"{stderr.rstrip()}\n{message}".strip(),
            "duration_seconds": duration,
            "timed_out": True,
            "timeout_seconds": timeout_seconds,
        }

    duration = round(time.monotonic() - started, 4)
    return {
        "argv": argv,
        "cwd": relative_to_root(cwd or ROOT),
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "duration_seconds": duration,
        "timed_out": False,
        "timeout_seconds": timeout_seconds,
    }


def repo_relpath(path: pathlib.Path) -> str:
    return ensure_relative_to_root(path)


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
    return (ROOT / path_str).exists()


def sanitize_env(extra_env: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    return env
