"""Regression coverage for bounded outcome subprocesses and provider budgets."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

from benchmark_contracts_helpers import RESULTS_ROOT, ROOT, load_module


def _run_outcome_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # nosec B603
        [sys.executable, str(ROOT / "evals/scripts/run_outcome_benchmark.py"), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _write_over_budget_bundle(temp_dir: pathlib.Path, task: dict) -> pathlib.Path:
    bundle = {
        "benchmark_id": "provider-budget-test",
        "status": "experimental",
        "tasks": [{**task, "task_id": f"provider-budget-{index}"} for index in range(5)],
    }
    bundle_path = temp_dir / "bundle.task-bundle.json"
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
    return bundle_path


def test_run_command_timeout_terminates_spawned_process_group() -> None:
    if os.name != "posix":
        return
    common = load_module("evals_common_timeout_group", "evals/scripts/common.py")
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="timeout-group-") as tmp:
        temp_dir = pathlib.Path(tmp)
        marker = temp_dir / "late-marker"
        child_pid = temp_dir / "child.pid"
        gate = temp_dir / "start-gate"
        child_program = (
            "import pathlib,sys,time; "
            "gate=pathlib.Path(sys.argv[2]); "
            "while not gate.exists(): time.sleep(0.01); "
            "time.sleep(3); pathlib.Path(sys.argv[1]).write_text('late', encoding='utf-8')"
        )
        parent_program = (
            "import pathlib,subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2], "
            "sys.argv[4]]); "
            "pathlib.Path(sys.argv[3]).write_text(str(child.pid), encoding='utf-8'); time.sleep(30)"
        )
        result_holder: dict[str, object] = {}

        def run_bounded_command() -> None:
            result_holder["result"] = common.run_command(
                [
                    sys.executable,
                    "-c",
                    parent_program,
                    child_program,
                    str(marker),
                    str(child_pid),
                    str(gate),
                ],
                cwd=ROOT,
                timeout_seconds=2,
            )

        command_thread = threading.Thread(target=run_bounded_command)
        command_thread.start()
        setup_deadline = time.monotonic() + 1
        while not child_pid.exists() and time.monotonic() < setup_deadline:
            time.sleep(0.01)
        assert child_pid.is_file(), "test parent did not start the grandchild"
        gate.write_text("release", encoding="utf-8")
        command_thread.join(timeout=3)
        assert not command_thread.is_alive(), "timed-out command did not return"
        result = result_holder["result"]
        assert isinstance(result, dict)

        time.sleep(1.2)
        assert result["returncode"] == 124
        assert result["timed_out"] is True
        assert result["containment"]["status"] == "uncertain"
        assert "process group" in result["stderr"]
        assert not marker.exists(), "a timed-out command's grandchild escaped its process group"
        # The explicit gate proves the grandchild existed before timeout.  Its
        # absent delayed marker proves it did not outlive the process-group kill.


def test_outcome_cli_rejects_repeat_and_total_provider_call_budget_before_execution() -> None:
    policy = ROOT / "packages/orchestration/policies/default.autonomous-policy.json"
    fixture_root = ROOT / "evals/fixtures/autonomous-outcomes"
    fixture_task = json.loads(
        (ROOT / "evals/datasets/autonomous-outcomes/core.task-bundle.json").read_text(
            encoding="utf-8"
        )
    )["tasks"][0]

    too_many_repeats = _run_outcome_cli(
        [
            "--task-bundle",
            "evals/datasets/autonomous-outcomes/core.task-bundle.json",
            "--fixture-root",
            "evals/fixtures/autonomous-outcomes",
            "--output-dir",
            "evals/results/unused-outcome-budget-test",
            "--policy",
            "packages/orchestration/policies/default.autonomous-policy.json",
            "--split",
            "dev",
            "--repeats",
            "4",
        ]
    )
    assert too_many_repeats.returncode != 0
    assert "between 1 and 3" in too_many_repeats.stderr

    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="outcome-budget-") as tmp:
        temp_dir = pathlib.Path(tmp)
        bundle_path = _write_over_budget_bundle(temp_dir, fixture_task)
        completed = _run_outcome_cli(
            [
                "--task-bundle",
                str(bundle_path.relative_to(ROOT)),
                "--fixture-root",
                str(fixture_root.relative_to(ROOT)),
                "--output-dir",
                str((temp_dir / "out").relative_to(ROOT)),
                "--policy",
                str(policy.relative_to(ROOT)),
                "--split",
                fixture_task["split"],
                "--repeats",
                "3",
                "--acknowledge-provider-usage",
            ]
        )
        assert completed.returncode != 0
        assert "12 task attempts/provider calls" in completed.stderr
        assert not (temp_dir / "out").exists()


def test_outcome_bundle_schema_caps_task_count() -> None:
    schema = json.loads(
        (ROOT / "evals/schemas/outcome-task-bundle.schema.json").read_text(encoding="utf-8")
    )
    assert schema["properties"]["tasks"]["maxItems"] == 8
