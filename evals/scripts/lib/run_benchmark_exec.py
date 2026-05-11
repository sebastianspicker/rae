"""Executable benchmark task runners for the umbrella runtime families."""

from __future__ import annotations

import json
import pathlib
from typing import Any

from common import (
    ROOT,
    default_system_metadata,
    dump_json,
    iso_timestamp,
    load_json,
    repo_relpath,
    run_command,
    sanitize_env,
    today_iso,
)
from router import ROUTER_VERSION, route_task

from lib.run_benchmark_evidence import (
    build_task_verification_evidence,
    create_checkpoint,
    create_task_workspace,
    init_isolated_orchestration_workspace,
    merge_command_results,
    parse_run_id,
    write_command_result,
    write_task_spec,
)


def execute_orchestration(
    task: dict[str, Any], output_dir: pathlib.Path
) -> dict[str, Any]:
    """Exercise the long-horizon initialization path and capture its artifacts."""
    workspace = create_task_workspace(output_dir, task["task_id"])
    init_result = run_command(
        [
            "bash",
            str(ROOT / "scripts/rae.sh"),
            "workflow",
            "long-horizon",
            "init",
            str(workspace),
        ],
        cwd=ROOT,
    )
    run_id = parse_run_id(init_result["stdout"])
    trace_paths: list[str] = []
    artifact_paths: list[str] = []
    if run_id:
        trace = workspace / ".pipeline" / "runs" / run_id / "trace.jsonl"
        state = workspace / ".pipeline" / "pipeline-state.json"
        if trace.exists():
            trace_paths.append(repo_relpath(trace))
        if state.exists():
            artifact_paths.append(repo_relpath(state))
    return {
        "command_result": init_result,
        "trace_paths": trace_paths,
        "artifact_paths": artifact_paths,
        "workspace": repo_relpath(workspace),
    }


def execute_orchestration_review_loop(
    task: dict[str, Any], output_dir: pathlib.Path
) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    orchestration_root, init_result, run_id = init_isolated_orchestration_workspace(workspace)

    explain_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "record-review-state",
            "--run-id",
            run_id,
            "--state",
            "explain",
            "--status",
            "completed",
        ],
        cwd=orchestration_root,
    )
    fix_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "record-review-state",
            "--run-id",
            run_id,
            "--state",
            "fix",
            "--status",
            "approved",
            "--note",
            "benchmark exercises explicit fix confirmation without applying code changes",
        ],
        cwd=orchestration_root,
    )
    ship_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "record-review-state",
            "--run-id",
            run_id,
            "--state",
            "ship",
            "--status",
            "approved",
        ],
        cwd=orchestration_root,
    )

    trace_path = orchestration_root / ".pipeline" / "runs" / run_id / "trace.jsonl"
    state_path = orchestration_root / ".pipeline" / "pipeline-state.json"
    review_loop_path = (
        orchestration_root / ".pipeline" / "runs" / run_id / "review-loop.json"
    )

    return {
        "command_result": merge_command_results(
            init_result, explain_result, fix_result, ship_result
        ),
        "trace_paths": [repo_relpath(path) for path in (trace_path,) if path.exists()],
        "artifact_paths": [
            repo_relpath(path)
            for path in (state_path, review_loop_path)
            if path.exists()
        ],
        "workspace": repo_relpath(orchestration_root),
    }


def execute_orchestration_observability(
    task: dict[str, Any], output_dir: pathlib.Path
) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    orchestration_root, init_result, run_id = init_isolated_orchestration_workspace(workspace)

    start_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "start-phase",
            "--run-id",
            run_id,
            "--phase",
            "arm",
        ],
        cwd=orchestration_root,
    )
    gate_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "record-gate",
            "--run-id",
            run_id,
            "--phase",
            "arm",
            "--status",
            "pass",
        ],
        cwd=orchestration_root,
    )
    summary_result = run_command(
        [
            "node",
            "scripts/pipeline/runner.mjs",
            "summarize-progress",
            "--run-id",
            run_id,
        ],
        cwd=orchestration_root,
    )

    trace_path = orchestration_root / ".pipeline" / "runs" / run_id / "trace.jsonl"
    state_path = orchestration_root / ".pipeline" / "pipeline-state.json"
    progress_path = (
        orchestration_root / ".pipeline" / "runs" / run_id / "progress.summary.json"
    )
    trace_summary_path = (
        orchestration_root / ".pipeline" / "runs" / run_id / "trace.summary.json"
    )

    return {
        "command_result": merge_command_results(
            init_result, start_result, gate_result, summary_result
        ),
        "trace_paths": [repo_relpath(path) for path in (trace_path,) if path.exists()],
        "artifact_paths": [
            repo_relpath(path)
            for path in (state_path, progress_path, trace_summary_path)
            if path.exists()
        ],
        "workspace": repo_relpath(orchestration_root),
    }


def execute_ralph(task: dict[str, Any], output_dir: pathlib.Path) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    target_repo = workspace / "target-repo"
    target_repo.mkdir(parents=True, exist_ok=True)
    run_command(["git", "init", "-q", str(target_repo)], cwd=ROOT)

    bootstrap_result = run_command(
        [
            "bash",
            str(ROOT / "scripts/rae.sh"),
            "workflow",
            "repo-audit",
            "bootstrap",
            str(target_repo),
        ],
        cwd=ROOT,
    )
    embedded_root = target_repo / ".claude" / "ralph-audit"
    example_prd = embedded_root / "prd.json.example"
    active_prd = embedded_root / "prd.json"
    active_prd.write_text(example_prd.read_text(encoding="utf-8"), encoding="utf-8")

    check_result = run_command(
        ["bash", str(embedded_root / "ralph.sh"), "--check"],
        cwd=target_repo,
        env=sanitize_env({"MODE": "audit"}),
    )

    artifact_paths = [
        repo_relpath(active_prd),
        repo_relpath(embedded_root / "ralph.sh"),
    ]
    trace_paths: list[str] = []
    events_log = embedded_root / ".runtime" / "events.log"
    if events_log.exists():
        trace_paths.append(repo_relpath(events_log))

    return {
        "command_result": check_result
        if check_result["returncode"] != 0
        else bootstrap_result
        | {
            "stdout": bootstrap_result["stdout"] + check_result["stdout"],
            "stderr": bootstrap_result["stderr"] + check_result["stderr"],
            "returncode": check_result["returncode"],
            "duration_seconds": round(
                bootstrap_result["duration_seconds"] + check_result["duration_seconds"],
                4,
            ),
        },
        "trace_paths": trace_paths,
        "artifact_paths": artifact_paths,
        "workspace": repo_relpath(workspace),
    }


def execute_tool(task: dict[str, Any], output_dir: pathlib.Path) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    repo_path = workspace / "hygiene-demo"
    repo_path.mkdir(parents=True, exist_ok=True)
    run_command(["git", "init", "-q", str(repo_path)], cwd=ROOT)
    run_command(
        ["git", "-C", str(repo_path), "config", "user.name", "RAE Bench"], cwd=ROOT
    )
    run_command(
        ["git", "-C", str(repo_path), "config", "user.email", "rae-bench@example.com"],
        cwd=ROOT,
    )
    readme = repo_path / "README.md"
    readme.write_text("demo\n", encoding="utf-8")
    run_command(["git", "-C", str(repo_path), "add", "README.md"], cwd=ROOT)
    run_command(["git", "-C", str(repo_path), "commit", "-qm", "demo"], cwd=ROOT)

    validate_result = run_command(
        [
            "bash",
            str(ROOT / "scripts/rae.sh"),
            "hygiene",
            "coauthor-cleaner",
            "--validate-only",
            "--no-push",
            "https://github.com/example/hygiene-demo",
            str(repo_path),
        ],
        cwd=ROOT,
    )

    return {
        "command_result": validate_result,
        "trace_paths": [],
        "artifact_paths": [repo_relpath(repo_path), repo_relpath(readme)],
        "workspace": repo_relpath(workspace),
    }


def judge_task(
    task: dict[str, Any],
    run_id: str,
    routed_runtime: str,
    command_result: dict[str, Any],
    artifact_paths: list[str],
    checkpoint_ok: bool,
) -> dict[str, Any]:
    """Apply the programmatic pass/fail rules for one benchmark task."""
    failures: list[str] = []
    route_ok = routed_runtime == task["expected_runtime"]
    if not route_ok:
        failures.append("route_mismatch")
    command_ok = command_result["returncode"] == 0
    if not command_ok:
        failures.append("command_failed")
    artifact_ok = True
    for path in artifact_paths:
        artifact_path = (ROOT / path).resolve(strict=False)
        if not artifact_path.exists():
            artifact_ok = False
            break
        if artifact_path.suffix != ".json":
            continue
        try:
            artifact = load_json(artifact_path)
        except json.JSONDecodeError:
            artifact_ok = False
            break
        if not isinstance(artifact, dict):
            artifact_ok = False
            break
    if not artifact_ok:
        failures.append("artifact_missing")
    if not checkpoint_ok:
        failures.append("checkpoint_blocked")

    verdict = "pass" if not failures else "fail"
    return {
        "verdict": verdict,
        "route_ok": route_ok,
        "command_ok": command_ok,
        "artifacts_ok": artifact_ok,
        "checkpoint_ok": checkpoint_ok,
        "failure_classes": failures,
    }


def execute_task(
    task: dict[str, Any],
    output_dir: pathlib.Path,
    run_id: str,
    checkpoint_mode: str,
    benchmark: dict[str, Any],
) -> dict[str, Any]:
    """Route, execute, judge, and write evidence for one task."""
    routed = route_task(task)
    task_spec_path = write_task_spec(output_dir, task)
    checkpoint_paths, checkpoint_ok, checkpoint_results = create_checkpoint(
        output_dir, run_id, task, checkpoint_mode
    )

    if routed["execution_profile"] == "orchestration-init":
        execution = execute_orchestration(task, output_dir)
    elif routed["execution_profile"] == "orchestration-review-loop":
        execution = execute_orchestration_review_loop(task, output_dir)
    elif routed["execution_profile"] == "orchestration-observability":
        execution = execute_orchestration_observability(task, output_dir)
    elif routed["execution_profile"] == "ralph-bootstrap-check":
        execution = execute_ralph(task, output_dir)
    elif routed["execution_profile"] == "coauthor-validate":
        execution = execute_tool(task, output_dir)
    else:
        raise ValueError(f"unknown execution_profile: {routed['execution_profile']}")

    if checkpoint_results:
        execution["command_result"] = merge_command_results(
            *checkpoint_results, execution["command_result"]
        )

    expected_artifacts = execution["artifact_paths"]
    command_result_path = write_command_result(
        output_dir, task["task_id"], execution["command_result"]
    )
    command_result_rel = repo_relpath(command_result_path)
    expected_artifacts = sorted(set([*expected_artifacts, command_result_rel]))
    verification_evidence = build_task_verification_evidence(
        task,
        command_result_path=command_result_rel,
        trace_paths=execution["trace_paths"],
        artifact_paths=expected_artifacts,
        checkpoint_paths=checkpoint_paths,
    )
    judgment = judge_task(
        task,
        run_id,
        routed["runtime"],
        execution["command_result"],
        expected_artifacts,
        checkpoint_ok,
    )
    planned_result_path = (
        output_dir / "planned-run-cards" / f"{task['task_id']}.run-card.json"
    )
    route_run_card = {
        "run_id": run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "date": today_iso(),
        "split": task["split"],
        "system": default_system_metadata(routed["runtime"]),
        "judge_version": benchmark["judge_version"],
        "command": routed["command_preview"],
        "result_path": repo_relpath(planned_result_path),
        "status": judgment["verdict"],
        "task_id": task["task_id"],
        "task_spec_path": repo_relpath(task_spec_path),
        "routed_runtime": routed["runtime"],
        "router": {
            "version": ROUTER_VERSION,
            "decided_at": iso_timestamp(),
            "reasons": routed["reasons"],
            "execution_profile": routed["execution_profile"],
        },
        "checkpoint_paths": checkpoint_paths,
        "trace_paths": execution["trace_paths"],
        "artifact_paths": expected_artifacts,
        "verification_evidence": verification_evidence,
        "claim_links": task.get("claim_links", []),
        "notes": task.get("notes", ""),
    }
    if task.get("workflow_verb"):
        route_run_card["workflow_verb"] = task["workflow_verb"]
    if task.get("delegation_contract"):
        route_run_card["delegation_contract"] = task["delegation_contract"]
    dump_json(planned_result_path, route_run_card)

    return {
        "task_id": task["task_id"],
        "title": task["title"],
        "split": task["split"],
        "family": task["family"],
        "expected_runtime": task["expected_runtime"],
        "routed_runtime": routed["runtime"],
        "execution_profile": routed["execution_profile"],
        "command_result": execution["command_result"],
        "trace_paths": execution["trace_paths"],
        "artifact_paths": expected_artifacts,
        "checkpoint_paths": checkpoint_paths,
        "verification_evidence": verification_evidence,
        "claim_links": task.get("claim_links", []),
        "judge": judgment,
        "route_run_card_path": repo_relpath(planned_result_path),
        "workspace": execution["workspace"],
    }
