#!/usr/bin/env python3
"""Bounded process supervisor for Ralph's Codex child process."""

import argparse
import contextlib
import os
import selectors
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

TIMEOUT_EXIT = 124
OVERFLOW_EXIT = 125
DEFAULT_GRACE_SECONDS = 15
DEFAULT_RAW_LIMIT = 16 * 1024 * 1024
DEFAULT_REPORT_LIMIT = 2 * 1024 * 1024


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


@dataclass
class ChildProcess:
    pid: int
    output_fd: int
    returncode: int | None = None

    def poll(self) -> int | None:
        if self.returncode is not None:
            return self.returncode
        waited_pid, status = os.waitpid(self.pid, os.WNOHANG)
        if waited_pid == 0:
            return None
        self.returncode = os.waitstatus_to_exitcode(status)
        return self.returncode

    def wait_for(self, seconds: int | None) -> bool:
        deadline = None if seconds is None else time.monotonic() + seconds
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
        return True


@dataclass
class MonitorState:
    raw_written: int = 0
    overflow: bool = False
    timed_out: bool = False


def spawn_child(command: list[str]) -> ChildProcess:
    """Start Ralph's trusted argv in its own process group and collect bounded output.

    The production caller builds this vector in ``runner_tool.sh`` from a
    verified absolute Codex executable and fixed Ralph options. This helper
    intentionally accepts an argv vector so tests and the local supervisor CLI
    can exercise process-group and output-limit behavior. It never invokes a
    shell or parses a command string.
    """
    if not command or not command[0] or any("\0" in argument for argument in command):
        raise ValueError("command must be a non-empty argv vector without NUL bytes")
    read_fd, write_fd = os.pipe()
    file_actions = [
        (os.POSIX_SPAWN_DUP2, write_fd, 1),
        (os.POSIX_SPAWN_DUP2, write_fd, 2),
        (os.POSIX_SPAWN_CLOSE, read_fd),
        (os.POSIX_SPAWN_CLOSE, write_fd),
    ]
    try:
        # nosemgrep: dangerous-spawn-process-audit
        pid = os.posix_spawnp(
            command[0],
            command,
            os.environ,
            file_actions=file_actions,
            setsid=True,
        )
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise
    os.close(write_fd)
    os.set_blocking(read_fd, False)
    return ChildProcess(pid=pid, output_fd=read_fd)


def terminate_group(child: ChildProcess, grace_seconds: int) -> None:
    """Stop the complete child process group, escalating only after its grace period."""
    if child.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGINT)
    if child.wait_for(grace_seconds):
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGKILL)
    child.wait_for(None)


def report_too_large(path: Path, limit: int) -> bool:
    try:
        return path.stat().st_size > limit
    except FileNotFoundError:
        return False


def write_bounded(raw: BinaryIO, chunk: bytes, state: MonitorState, limit: int) -> None:
    """Persist only the allowed output prefix and remember that the limit was exceeded."""
    remaining = max(0, limit - state.raw_written)
    kept = chunk[:remaining]
    if kept:
        raw.write(kept)
        state.raw_written += len(kept)
    if len(chunk) > remaining:
        state.overflow = True


def read_ready_output(
    selector: selectors.BaseSelector,
    raw: BinaryIO,
    state: MonitorState,
    raw_limit: int,
) -> None:
    for key, _ in selector.select(0.1):
        chunk = os.read(key.fd, 64 * 1024)
        if chunk:
            write_bounded(raw, chunk, state, raw_limit)
        else:
            selector.unregister(key.fileobj)


def drain_output(
    child: ChildProcess,
    raw: BinaryIO,
    state: MonitorState,
    limit: int,
) -> None:
    with contextlib.suppress(BlockingIOError):
        while chunk := os.read(child.output_fd, 64 * 1024):
            write_bounded(raw, chunk, state, limit)


def enforce_deadline_and_limits(
    child: ChildProcess,
    args: argparse.Namespace,
    state: MonitorState,
    deadline: float,
) -> None:
    if state.timed_out or state.overflow:
        return
    if time.monotonic() >= deadline:
        state.timed_out = True
    elif report_too_large(args.report, args.report_limit):
        state.overflow = True
    if state.timed_out or state.overflow:
        terminate_group(child, args.grace)


def monitor_child(
    child: ChildProcess,
    args: argparse.Namespace,
    raw: BinaryIO,
    deadline: float,
) -> MonitorState:
    state = MonitorState()
    selector = selectors.DefaultSelector()
    selector.register(child.output_fd, selectors.EVENT_READ)
    while child.poll() is None or selector.get_map():
        enforce_deadline_and_limits(child, args, state, deadline)
        read_ready_output(selector, raw, state, args.raw_limit)
        if state.overflow:
            terminate_group(child, args.grace)
        if (state.timed_out or state.overflow) and child.poll() is not None:
            drain_output(child, raw, state, args.raw_limit)
            break
    selector.close()
    os.close(child.output_fd)
    return state


def result_code(child: ChildProcess, args: argparse.Namespace, state: MonitorState) -> int:
    if report_too_large(args.report, args.report_limit):
        state.overflow = True
    if state.overflow:
        return OVERFLOW_EXIT
    if state.timed_out:
        return TIMEOUT_EXIT
    return child.returncode if child.returncode is not None else 1


def supervise(args: argparse.Namespace) -> int:
    """Run one agent command with durable output, deadline, and report-size enforcement."""
    deadline = time.monotonic() + args.timeout
    args.raw_output.parent.mkdir(parents=True, exist_ok=True)
    child = spawn_child(args.command)
    with args.raw_output.open("wb") as raw:
        state = monitor_child(child, args, raw, deadline)
        raw.flush()
        os.fsync(raw.fileno())
    return result_code(child, args, state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=positive_int, required=True)
    parser.add_argument("--grace", type=positive_int, default=DEFAULT_GRACE_SECONDS)
    parser.add_argument("--raw-output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--raw-limit", type=positive_int, default=DEFAULT_RAW_LIMIT)
    parser.add_argument("--report-limit", type=positive_int, default=DEFAULT_REPORT_LIMIT)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    parsed = parser.parse_args()
    if parsed.command[:1] == ["--"]:
        parsed.command = parsed.command[1:]
    if not parsed.command:
        parser.error("missing command after --")
    return parsed


if __name__ == "__main__":
    raise SystemExit(supervise(parse_args()))
