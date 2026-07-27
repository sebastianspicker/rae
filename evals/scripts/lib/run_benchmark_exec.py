"""Executable benchmark task runners for the umbrella runtime families."""

import json
import pathlib
from dataclasses import dataclass
from typing import Any

from common import (
    RESULTS_ROOT,
    ROOT,
    default_system_metadata,
    dump_json,
    iso_timestamp,
    load_json,
    repo_relpath,
    resolve_metadata_path,
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


@dataclass(frozen=True, slots=True)
class _RouteCardContext:
    task: dict[str, Any]
    benchmark: dict[str, Any]
    routed: dict[str, Any]
    execution: dict[str, Any]
    run_id: str
    task_spec_path: pathlib.Path
    output_dir: pathlib.Path
    artifacts: list[str]
    checkpoint_paths: list[str]
    evidence: dict[str, Any]
    judgment: dict[str, Any]

    @property
    def planned_result_path(self) -> pathlib.Path:
        task_id = self.task["task_id"]
        return self.output_dir / "planned-run-cards" / f"{task_id}.run-card.json"


def execute_orchestration(task: dict[str, Any], output_dir: pathlib.Path) -> dict[str, Any]:
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


def _record_review_state(
    orchestration_root: pathlib.Path,
    run_id: str,
    state: str,
    status: str,
    note: str | None = None,
) -> dict[str, Any]:
    command = [
        "node",
        "scripts/pipeline/runner.mjs",
        "record-review-state",
        "--run-id",
        run_id,
        "--state",
        state,
        "--status",
        status,
    ]
    if note:
        command.extend(["--note", note])
    return run_command(command, cwd=orchestration_root)


def _review_loop_artifacts(
    orchestration_root: pathlib.Path, run_id: str
) -> tuple[list[str], list[str]]:
    run_root = orchestration_root / ".pipeline" / "runs" / run_id
    trace_path = run_root / "trace.jsonl"
    artifacts = [
        orchestration_root / ".pipeline" / "pipeline-state.json",
        run_root / "review-loop.json",
    ]
    traces = [repo_relpath(trace_path)] if trace_path.exists() else []
    return traces, [repo_relpath(path) for path in artifacts if path.exists()]


def execute_orchestration_review_loop(
    task: dict[str, Any], output_dir: pathlib.Path
) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    orchestration_root, init_result, run_id = init_isolated_orchestration_workspace(workspace)
    explain_result = _record_review_state(orchestration_root, run_id, "explain", "completed")
    fix_result = _record_review_state(
        orchestration_root,
        run_id,
        "fix",
        "approved",
        "benchmark exercises explicit fix confirmation without applying code changes",
    )
    ship_result = _record_review_state(orchestration_root, run_id, "ship", "approved")
    trace_paths, artifact_paths = _review_loop_artifacts(orchestration_root, run_id)
    return {
        "command_result": merge_command_results(
            init_result, explain_result, fix_result, ship_result
        ),
        "trace_paths": trace_paths,
        "artifact_paths": artifact_paths,
        "workspace": repo_relpath(orchestration_root),
    }


def _run_observability_commands(
    orchestration_root: pathlib.Path, run_id: str
) -> list[dict[str, Any]]:
    commands = (
        ["start-phase", "--phase", "arm"],
        ["record-gate", "--phase", "arm", "--status", "pass"],
        ["summarize-progress"],
    )
    return [
        run_command(
            ["node", "scripts/pipeline/runner.mjs", *args, "--run-id", run_id],
            cwd=orchestration_root,
        )
        for args in commands
    ]


def _observability_artifacts(
    orchestration_root: pathlib.Path, run_id: str
) -> tuple[list[str], list[str]]:
    run_root = orchestration_root / ".pipeline" / "runs" / run_id
    trace = run_root / "trace.jsonl"
    artifacts = (
        orchestration_root / ".pipeline" / "pipeline-state.json",
        run_root / "progress.summary.json",
        run_root / "trace.summary.json",
    )
    traces = [repo_relpath(trace)] if trace.exists() else []
    return traces, [repo_relpath(path) for path in artifacts if path.exists()]


def execute_orchestration_observability(
    task: dict[str, Any], output_dir: pathlib.Path
) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    orchestration_root, init_result, run_id = init_isolated_orchestration_workspace(workspace)
    results = _run_observability_commands(orchestration_root, run_id)
    trace_paths, artifact_paths = _observability_artifacts(orchestration_root, run_id)
    return {
        "command_result": merge_command_results(init_result, *results),
        "trace_paths": trace_paths,
        "artifact_paths": artifact_paths,
        "workspace": repo_relpath(orchestration_root),
    }


def _prepare_ralph_target(
    workspace: pathlib.Path,
) -> tuple[pathlib.Path, dict[str, Any]]:
    target_repo = workspace / "target-repo"
    target_repo.mkdir(parents=True, exist_ok=True)
    run_command(["git", "init", "-q", str(target_repo)], cwd=ROOT)
    bootstrap = run_command(
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
    return target_repo, bootstrap


def _ralph_result(bootstrap: dict[str, Any], check: dict[str, Any]) -> dict[str, Any]:
    if check["returncode"] != 0:
        return check
    return bootstrap | {
        "stdout": bootstrap["stdout"] + check["stdout"],
        "stderr": bootstrap["stderr"] + check["stderr"],
        "returncode": check["returncode"],
        "duration_seconds": round(bootstrap["duration_seconds"] + check["duration_seconds"], 4),
    }


def execute_ralph(task: dict[str, Any], output_dir: pathlib.Path) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    target_repo, bootstrap_result = _prepare_ralph_target(workspace)
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
        "command_result": _ralph_result(bootstrap_result, check_result),
        "trace_paths": trace_paths,
        "artifact_paths": artifact_paths,
        "workspace": repo_relpath(workspace),
    }


def execute_tool(task: dict[str, Any], output_dir: pathlib.Path) -> dict[str, Any]:
    workspace = create_task_workspace(output_dir, task["task_id"])
    repo_path = workspace / "hygiene-demo"
    repo_path.mkdir(parents=True, exist_ok=True)
    run_command(["git", "init", "-q", str(repo_path)], cwd=ROOT)
    run_command(["git", "-C", str(repo_path), "config", "user.name", "RAE Bench"], cwd=ROOT)
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
    artifact_ok = _artifacts_are_valid(artifact_paths)
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


def _artifacts_are_valid(artifact_paths: list[str]) -> bool:
    for path in artifact_paths:
        try:
            artifact_path = resolve_metadata_path(
                path, label="artifact path", contained_by=RESULTS_ROOT
            )
        except ValueError:
            return False
        if not artifact_path.exists():
            return False
        if artifact_path.suffix != ".json":
            continue
        try:
            artifact = load_json(artifact_path)
        except json.JSONDecodeError:
            return False
        if not isinstance(artifact, dict):
            return False
    return True


def _execute_profile(
    task: dict[str, Any], output_dir: pathlib.Path, profile: str
) -> dict[str, Any]:
    if profile == "orchestration-init":
        return execute_orchestration(task, output_dir)
    if profile == "orchestration-review-loop":
        return execute_orchestration_review_loop(task, output_dir)
    if profile == "orchestration-observability":
        return execute_orchestration_observability(task, output_dir)
    if profile == "ralph-bootstrap-check":
        return execute_ralph(task, output_dir)
    if profile == "coauthor-validate":
        return execute_tool(task, output_dir)
    raise ValueError(f"unknown execution_profile: {profile}")


def _route_run_card(context: _RouteCardContext) -> dict[str, Any]:
    task = context.task
    benchmark = context.benchmark
    routed = context.routed
    execution = context.execution
    card = {
        "run_id": context.run_id,
        "evidence_type": "benchmark-run",
        "benchmark_id": benchmark["benchmark_id"],
        "benchmark_version": benchmark["version"],
        "date": today_iso(),
        "split": task["split"],
        "system": default_system_metadata(routed["runtime"]),
        "judge_version": benchmark["judge_version"],
        "command": routed["command_preview"],
        "result_path": repo_relpath(context.planned_result_path),
        "status": context.judgment["verdict"],
        "task_id": task["task_id"],
        "task_spec_path": repo_relpath(context.task_spec_path),
        "routed_runtime": routed["runtime"],
        "router": {
            "version": ROUTER_VERSION,
            "decided_at": iso_timestamp(),
            "reasons": routed["reasons"],
            "execution_profile": routed["execution_profile"],
        },
        "checkpoint_paths": context.checkpoint_paths,
        "trace_paths": execution["trace_paths"],
        "artifact_paths": context.artifacts,
        "verification_evidence": context.evidence,
        "claim_links": task.get("claim_links", []),
        "notes": task.get("notes", ""),
    }
    if task.get("workflow_verb"):
        card["workflow_verb"] = task["workflow_verb"]
    if task.get("delegation_contract"):
        card["delegation_contract"] = task["delegation_contract"]
    return card


def _collect_task_evidence(
    task: dict[str, Any],
    execution: dict[str, Any],
    output_dir: pathlib.Path,
    checkpoint_paths: list[str],
) -> tuple[list[str], dict[str, Any]]:
    command_result_path = write_command_result(
        output_dir, task["task_id"], execution["command_result"]
    )
    command_result_ref = repo_relpath(command_result_path)
    artifacts = sorted({*execution["artifact_paths"], command_result_ref})
    evidence = build_task_verification_evidence(
        task,
        command_result_path=command_result_ref,
        trace_paths=execution["trace_paths"],
        artifact_paths=artifacts,
        checkpoint_paths=checkpoint_paths,
    )
    return artifacts, evidence


def _task_result(
    task: dict[str, Any],
    routed: dict[str, Any],
    execution: dict[str, Any],
    artifacts: list[str],
    checkpoint_paths: list[str],
    evidence: dict[str, Any],
    judgment: dict[str, Any],
    planned_result_path: pathlib.Path,
) -> dict[str, Any]:
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
        "artifact_paths": artifacts,
        "checkpoint_paths": checkpoint_paths,
        "verification_evidence": evidence,
        "claim_links": task.get("claim_links", []),
        "judge": judgment,
        "route_run_card_path": repo_relpath(planned_result_path),
        "workspace": execution["workspace"],
    }


def _write_task_route_card(context: _RouteCardContext) -> pathlib.Path:
    path = context.planned_result_path
    dump_json(path, _route_run_card(context))
    return path


def _prepend_checkpoint_results(
    execution: dict[str, Any], checkpoint_results: list[dict[str, Any]]
) -> None:
    if checkpoint_results:
        execution["command_result"] = merge_command_results(
            *checkpoint_results, execution["command_result"]
        )


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
    execution = _execute_profile(task, output_dir, routed["execution_profile"])
    _prepend_checkpoint_results(execution, checkpoint_results)
    expected_artifacts, verification_evidence = _collect_task_evidence(
        task, execution, output_dir, checkpoint_paths
    )
    judgment = judge_task(
        task,
        run_id,
        routed["runtime"],
        execution["command_result"],
        expected_artifacts,
        checkpoint_ok,
    )
    route_context = _RouteCardContext(
        task=task,
        benchmark=benchmark,
        routed=routed,
        execution=execution,
        run_id=run_id,
        task_spec_path=task_spec_path,
        output_dir=output_dir,
        artifacts=expected_artifacts,
        checkpoint_paths=checkpoint_paths,
        evidence=verification_evidence,
        judgment=judgment,
    )
    planned_result_path = _write_task_route_card(route_context)
    return _task_result(
        task,
        routed,
        execution,
        expected_artifacts,
        checkpoint_paths,
        verification_evidence,
        judgment,
        planned_result_path,
    )
