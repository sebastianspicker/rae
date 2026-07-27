"""Execution-safety contracts for autonomous outcome evaluation."""

__test__ = False

import os
import pathlib
import sys
import tempfile

from outcome_optimizer_helpers import (
    RESULTS_ROOT,
    aggregate_repeats,
    evaluator_safety_failure,
    run_outcome_task,
    task,
    trusted_judge_argv,
)


def test_outcome_task_uses_closed_judge_registry_and_detects_scope_violation() -> None:
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-outcome-") as tmp:
        root = pathlib.Path(tmp)
        fixture = root / "fixture"
        fixture.mkdir()
        (fixture / "app.py").write_text("value = 1\n", encoding="utf-8")
        (fixture / "README.md").write_text("keep\n", encoding="utf-8")
        runner = root / "runner.py"
        runner.write_text(
            "import pathlib, sys\np=pathlib.Path(sys.argv[sys.argv.index('--workspace')+1])\n"
            "(p / 'README.md').unlink()\n",
            encoding="utf-8",
        )
        result = run_outcome_task(
            task=task(),
            fixture_root=fixture,
            workspace=root / "workspace",
            candidate_runner_argv=[sys.executable, str(runner)],
        )
    assert result["verdict"] == "fail"
    assert "scope_violation" in result["failure_classes"]
    assert "forbidden_deletion" in result["failure_classes"]


def test_outcome_repeat_aggregation_keeps_hard_failures_visible() -> None:
    aggregate = aggregate_repeats(
        [
            [{"verdict": "pass", "failure_classes": []}],
            [{"verdict": "fail", "failure_classes": ["timeout"]}],
        ]
    )
    assert aggregate["status"] == "fail"
    assert aggregate["hard_failure_classes"] == ["timeout"]


def test_unknown_judge_case_is_rejected_before_command_execution() -> None:
    unknown_task = task() | {"judge_case_id": "user-shell"}
    try:
        trusted_judge_argv(pathlib.Path("."), unknown_task)
    except ValueError as exc:
        assert "unknown trusted judge_case_id" in str(exc)
    else:
        raise AssertionError("unknown judge case was accepted")


def test_outcome_judge_never_follows_candidate_symlinks() -> None:
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-outcome-symlink-") as tmp:
        root = pathlib.Path(tmp)
        fixture = root / "fixture"
        fixture.mkdir()
        (fixture / "app.py").write_text("value = 1\n", encoding="utf-8")
        (fixture / "README.md").write_text("keep\n", encoding="utf-8")
        external = root / "external.py"
        external.write_text("external_secret = 'must-not-read'\n", encoding="utf-8")
        runner = root / "runner.py"
        runner.write_text(
            "import os, pathlib, sys\n"
            "p=pathlib.Path(sys.argv[sys.argv.index('--workspace')+1])/'app.py'\n"
            "p.unlink()\n"
            f"os.symlink({str(external)!r}, p)\n",
            encoding="utf-8",
        )
        result = run_outcome_task(
            task=task(),
            fixture_root=fixture,
            workspace=root / "workspace",
            candidate_runner_argv=[sys.executable, str(runner)],
        )
    assert "unsafe_file_type" in result["failure_classes"]
    assert result["verifier"]["returncode"] == 1


def test_outcome_judge_never_falls_back_to_unsandboxed_candidate_execution() -> None:
    with tempfile.TemporaryDirectory(dir=RESULTS_ROOT, prefix="rae-outcome-sandbox-") as tmp:
        root = pathlib.Path(tmp)
        fixture = root / "fixture"
        fixture.mkdir()
        marker = root / "ambient-write.txt"
        fake_marker = root / "fake-sandbox-used.txt"
        fake_bin = root / "bin"
        fake_bin.mkdir()
        fake_sandbox = fake_bin / "sandbox-exec"
        fake_sandbox.write_text(
            f"#!/bin/sh\nprintf used > {str(fake_marker)!r}\nexit 1\n",
            encoding="utf-8",
        )
        fake_sandbox.chmod(0o755)
        (fixture / "app.py").write_text("value = 1\n", encoding="utf-8")
        (fixture / "README.md").write_text("keep\n", encoding="utf-8")
        runner = root / "runner.py"
        runner.write_text(
            "import pathlib, sys\n"
            "p=pathlib.Path(sys.argv[sys.argv.index('--workspace')+1])/'app.py'\n"
            'p.write_text("import pathlib\\npathlib.Path('
            f"{str(marker)!r}).write_text('escaped')\\n\")\n",
            encoding="utf-8",
        )
        previous_path = os.environ.get("PATH", "")
        try:
            os.environ["PATH"] = f"{fake_bin}{os.pathsep}{previous_path}"
            result = run_outcome_task(
                task=task(),
                fixture_root=fixture,
                workspace=root / "workspace",
                candidate_runner_argv=[sys.executable, str(runner)],
            )
        finally:
            os.environ["PATH"] = previous_path
    assert not marker.exists()
    assert not fake_marker.exists()
    assert evaluator_safety_failure(result["verifier"])
    assert "evaluator_safety_failure" in result["failure_classes"]
