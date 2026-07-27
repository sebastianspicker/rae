#!/usr/bin/env python3
"""Validate eval benchmark, run-card, and task-bundle metadata."""

import pathlib
import re
import sys
from typing import Any, cast

from common import RESULTS_ROOT, ROOT, load_json_object, resolve_metadata_path
from router import EXECUTION_PROFILE_RUNTIMES

from lib.outcome_eval import validate_outcome_task
from lib.policy_optimizer import validate_campaign, validate_policy
from lib.validate_eval_metadata_contracts import (
    BENCHMARK_SPLITS,
    BENCHMARK_STATUSES,
    CONTAMINATION_RISKS,
    EVALS,
    JUDGE_TYPES,
    PUBLICATION_STATUSES,
    RUN_EVIDENCE_TYPES,
    RUN_STATUSES,
    RUNTIME_CHOICES,
    WORKFLOW_VERBS,
    iter_benchmark_paths,
    iter_optimizer_campaign_paths,
    iter_outcome_bundle_paths,
    iter_run_paths,
    iter_task_bundle_paths,
    validate_baseline_result,
    validate_delegation_contract,
    validate_judge_config,
    validate_verification_evidence,
)

BENCHMARK_PATH_ROOTS = {
    "scenario_path": EVALS / "scenarios",
    "task_specs_path": EVALS / "datasets",
    "judge_path": EVALS / "judges",
}
RUN_RESULT_PATH_FIELDS = {
    "ledger_path",
    "regression_report_path",
    "judge_calibration_report_path",
    "release_gate_report_path",
}
RUN_RESULT_PATH_LISTS = {"trace_paths", "artifact_paths", "checkpoint_paths"}


def _label(path: pathlib.Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _load_object(path: pathlib.Path) -> dict[str, Any]:
    return cast(dict[str, Any], load_json_object(path))


def _require_keys(data: dict[str, Any], required: set[str], owner: str) -> None:
    missing = required - set(data)
    if missing:
        raise ValueError(f"{owner} is missing keys: {', '.join(sorted(missing))}")


def _require_non_empty_list(value: object, message: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ValueError(message)
    return value


def _validate_claim_links(value: object, owner: str, *, required: bool = True) -> list[str]:
    if not isinstance(value, list) or (required and not value):
        qualifier = "non-empty " if required else ""
        raise ValueError(f"{owner} claim_links must be a {qualifier}array")
    links = value
    validated: list[str] = []
    for link in links:
        if not isinstance(link, str):
            raise ValueError(f"{owner} has unresolved claim_link: {link}")
        resolved = resolve_metadata_path(link, label=f"{owner} claim_link", contained_by=ROOT)
        if not resolved.exists():
            raise ValueError(f"{owner} has unresolved claim_link: {link}")
        validated.append(link)
    return validated


def _validate_benchmark_enums(data: dict[str, Any], owner: str) -> None:
    checks = (
        ("status", BENCHMARK_STATUSES),
        ("judge_type", JUDGE_TYPES),
        ("contamination_risk", CONTAMINATION_RISKS),
        ("publication_status", PUBLICATION_STATUSES),
    )
    for field, choices in checks:
        if data[field] not in choices:
            raise ValueError(f"{owner} has invalid {field}")


def _validate_benchmark_lists(data: dict[str, Any], owner: str) -> list[str]:
    split_policy = _require_non_empty_list(
        data["split_policy"], f"{owner} split_policy must be a non-empty array"
    )
    if not set(split_policy).issubset(BENCHMARK_SPLITS):
        raise ValueError(f"{owner} split_policy contains invalid values")
    _require_non_empty_list(
        data["failure_classes"],
        f"{owner} failure_classes must be a non-empty array",
    )
    return cast(list[str], split_policy)


def _validate_benchmark_paths(data: dict[str, Any], owner: str) -> None:
    missing_messages = {
        "scenario_path": "points to a missing scenario_path",
        "task_specs_path": "points to a missing task_specs_path",
        "judge_path": "points to a missing judge_path",
    }
    for field, root in BENCHMARK_PATH_ROOTS.items():
        resolved = resolve_metadata_path(data[field], label=f"{owner} {field}", contained_by=root)
        if not resolved.exists():
            raise ValueError(f"{owner} {missing_messages[field]}")
        if field == "judge_path":
            validate_judge_config(resolved)


def _validate_regression_policy(data: dict[str, Any], owner: str) -> None:
    policy = data["regression_policy"]
    if not isinstance(policy, dict):
        raise ValueError(f"{owner} regression_policy must be an object")
    baselines = policy.get("baseline_results")
    if not isinstance(baselines, dict) or not baselines:
        raise ValueError(f"{owner} regression_policy.baseline_results must be a non-empty object")
    for split_name, baseline_ref in baselines.items():
        if split_name not in BENCHMARK_SPLITS:
            raise ValueError(f"{owner} baseline_results has invalid split key: {split_name}")
        baseline_path = resolve_metadata_path(
            baseline_ref,
            label=f"{owner} baseline result",
            contained_by=RESULTS_ROOT,
        )
        if not baseline_path.exists():
            raise ValueError(f"{owner} baseline result missing: {baseline_ref}")
        validate_baseline_result(baseline_path)


def _validate_release_gate(
    data: dict[str, Any], owner: str, split_policy: list[str], claim_links: list[str]
) -> None:
    gate = data["release_gate"]
    if not isinstance(gate, dict):
        raise ValueError(f"{owner} release_gate must be an object")
    required_splits = _require_non_empty_list(
        gate.get("required_splits"),
        f"{owner} release_gate.required_splits must be non-empty",
    )
    if not set(required_splits).issubset(BENCHMARK_SPLITS):
        raise ValueError(f"{owner} release_gate.required_splits contains invalid values")
    if not set(required_splits).issubset(split_policy):
        raise ValueError(f"{owner} release_gate.required_splits must be a subset of split_policy")
    required_links = _require_non_empty_list(
        gate.get("required_claim_links"),
        f"{owner} release_gate.required_claim_links must be non-empty",
    )
    if any(link not in claim_links for link in required_links):
        raise ValueError(
            f"{owner} release_gate.required_claim_links must be included in claim_links"
        )


def validate_benchmark_card(path: pathlib.Path) -> tuple[str, str]:
    data = _load_object(path)
    owner = _label(path)
    required = {
        "benchmark_id",
        "version",
        "family",
        "status",
        "scenario_path",
        "task_specs_path",
        "split_policy",
        "success_metric",
        "failure_classes",
        "judge_type",
        "judge_version",
        "judge_path",
        "contamination_risk",
        "publication_status",
        "claim_links",
        "regression_policy",
        "release_gate",
    }
    _require_keys(data, required, owner)
    _validate_benchmark_enums(data, owner)
    split_policy = _validate_benchmark_lists(data, owner)
    _validate_benchmark_paths(data, owner)
    claim_links = _validate_claim_links(data["claim_links"], owner)
    _validate_regression_policy(data, owner)
    _validate_release_gate(data, owner, split_policy, claim_links)
    benchmark_id = str(data["benchmark_id"])
    version = str(data["version"])
    if not benchmark_id or not version:
        raise ValueError(f"{owner} benchmark_id and version must be non-empty strings")
    return benchmark_id, version


def _validate_system(data: dict[str, Any], owner: str) -> None:
    system = data["system"]
    if not isinstance(system, dict):
        raise ValueError(f"{owner} system must be an object")
    for key in ("model", "runtime"):
        if not isinstance(system.get(key), str) or not system[key]:
            raise ValueError(f"{owner} system.{key} must be a non-empty string")


def _validate_run_path_lists(data: dict[str, Any], owner: str) -> None:
    for key in RUN_RESULT_PATH_LISTS:
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, list):
            raise ValueError(f"{owner} {key} must be an array when present")
        for index, path_ref in enumerate(value):
            resolve_metadata_path(
                path_ref,
                label=f"{owner} {key}[{index}]",
                contained_by=RESULTS_ROOT,
            )
    claim_links = data.get("claim_links")
    if claim_links is not None:
        _validate_claim_links(claim_links, owner, required=False)


def _validate_run_paths(data: dict[str, Any], owner: str) -> None:
    task_spec_path = data.get("task_spec_path")
    if task_spec_path is not None:
        resolve_metadata_path(task_spec_path, label=f"{owner} task_spec_path", contained_by=EVALS)
    for field in RUN_RESULT_PATH_FIELDS:
        value = data.get(field)
        if value is not None:
            resolve_metadata_path(value, label=f"{owner} {field}", contained_by=RESULTS_ROOT)
    _validate_run_path_lists(data, owner)


def _validate_run_routing_metadata(data: dict[str, Any], owner: str) -> None:
    routed_runtime = data.get("routed_runtime")
    if routed_runtime is not None and routed_runtime not in RUNTIME_CHOICES | {"mixed"}:
        raise ValueError(f"{owner} has invalid routed_runtime")
    workflow_verb = data.get("workflow_verb")
    if workflow_verb is not None and workflow_verb not in WORKFLOW_VERBS:
        raise ValueError(f"{owner} has invalid workflow_verb")


def _validate_run_contract_metadata(data: dict[str, Any], owner: str) -> None:
    if data.get("delegation_contract") is not None:
        validate_delegation_contract(data["delegation_contract"], f"{owner} delegation_contract")
    if data.get("verification_evidence") is not None:
        validate_verification_evidence(
            data["verification_evidence"], f"{owner} verification_evidence"
        )


def _validate_run_common(data: dict[str, Any], owner: str) -> str:
    _require_keys(data, {"run_id", "date", "system", "status"}, owner)
    evidence_type = str(data.get("evidence_type", "benchmark-run"))
    if evidence_type not in RUN_EVIDENCE_TYPES:
        raise ValueError(f"{owner} has invalid evidence_type")
    if data["status"] not in RUN_STATUSES:
        raise ValueError(f"{owner} has invalid status")
    _validate_system(data, owner)
    _validate_run_routing_metadata(data, owner)
    _validate_run_contract_metadata(data, owner)
    _validate_run_paths(data, owner)
    return evidence_type


def _validate_benchmark_run(
    data: dict[str, Any], owner: str, benchmarks: set[tuple[str, str]]
) -> None:
    required = {
        "benchmark_id",
        "benchmark_version",
        "split",
        "judge_version",
        "command",
        "result_path",
    }
    missing = required - set(data)
    if missing:
        raise ValueError(f"{owner} is missing benchmark-run keys: {', '.join(sorted(missing))}")
    if data["split"] not in BENCHMARK_SPLITS:
        raise ValueError(f"{owner} has invalid split")
    benchmark_ref = (str(data["benchmark_id"]), str(data["benchmark_version"]))
    if benchmark_ref not in benchmarks:
        raise ValueError(
            f"{owner} references unknown benchmark {benchmark_ref[0]}@{benchmark_ref[1]}"
        )
    resolve_metadata_path(
        data["result_path"],
        label=f"{owner} result_path",
        contained_by=RESULTS_ROOT,
    )


def _validate_observation(data: dict[str, Any], owner: str, evidence_type: str) -> None:
    required = {
        "observation_id",
        "observation_date",
        "capabilities_observed",
        "interpretation_limits",
    }
    missing = required - set(data)
    if missing:
        raise ValueError(f"{owner} is missing observation keys: {', '.join(sorted(missing))}")
    observed = data["capabilities_observed"]
    if not isinstance(observed, list) or not observed:
        raise ValueError(f"{owner} capabilities_observed must be a non-empty array")
    if evidence_type == "vendor-doc":
        sources = data.get("source_links")
        if not isinstance(sources, list) or not sources:
            raise ValueError(f"{owner} vendor-doc observation requires source_links")


def validate_run_card(path: pathlib.Path, benchmarks: set[tuple[str, str]]) -> None:
    data = _load_object(path)
    owner = _label(path)
    evidence_type = _validate_run_common(data, owner)
    if evidence_type == "benchmark-run":
        _validate_benchmark_run(data, owner, benchmarks)
    else:
        _validate_observation(data, owner, evidence_type)


def _execution_profiles() -> set[str]:
    schema = _load_object(EVALS / "schemas/task-spec.schema.json")
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise ValueError("task-spec schema properties must be an object")
    profile_schema = properties.get("execution_profile")
    if not isinstance(profile_schema, dict):
        raise ValueError("task-spec schema execution_profile must be an object")
    choices = profile_schema.get("enum")
    if not isinstance(choices, list):
        raise ValueError("task-spec schema execution_profile.enum must be an array")
    return {choice for choice in choices if isinstance(choice, str)}


def _validate_execution_profile(
    task: dict[str, Any], owner: str, task_id: str, execution_profiles: set[str]
) -> None:
    profile = task.get("execution_profile")
    if profile is not None and (not isinstance(profile, str) or profile not in execution_profiles):
        raise ValueError(f"{owner} task {task_id} has invalid execution_profile")
    if profile is not None and EXECUTION_PROFILE_RUNTIMES[profile] != task["expected_runtime"]:
        raise ValueError(
            f"{owner} task {task_id} execution_profile does not match expected_runtime"
        )


def _validate_task_routing(
    task: dict[str, Any], owner: str, task_id: str, execution_profiles: set[str]
) -> None:
    if task.get("split") not in BENCHMARK_SPLITS:
        raise ValueError(f"{owner} task {task_id} has invalid split")
    if task.get("expected_runtime") not in RUNTIME_CHOICES:
        raise ValueError(f"{owner} task {task_id} has invalid expected_runtime")
    _validate_execution_profile(task, owner, task_id, execution_profiles)
    verb = task.get("workflow_verb")
    if verb is not None and verb not in WORKFLOW_VERBS:
        raise ValueError(f"{owner} task {task_id} has invalid workflow_verb")


def _validate_task_contracts(task: dict[str, Any], owner: str, task_id: str) -> None:
    if task.get("delegation_contract") is not None:
        validate_delegation_contract(
            task["delegation_contract"], f"{owner} task {task_id} delegation_contract"
        )
    claim_links = task.get("claim_links", [])
    if not isinstance(claim_links, list):
        raise ValueError(f"{owner} task {task_id} claim_links must be an array")
    for link in claim_links:
        if not isinstance(link, str):
            raise ValueError(f"{owner} task {task_id} has unresolved claim_link: {link}")
        resolved = resolve_metadata_path(
            link, label=f"{owner} task {task_id} claim_link", contained_by=ROOT
        )
        if not resolved.exists():
            raise ValueError(f"{owner} task {task_id} has unresolved claim_link: {link}")


def _validate_task(task: object, owner: str, execution_profiles: set[str], seen: set[str]) -> None:
    if not isinstance(task, dict):
        raise ValueError(f"{owner} tasks entries must be objects")
    task_id = task.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError(f"{owner} task missing task_id")
    if task_id in seen:
        raise ValueError(f"{owner} duplicate task_id: {task_id}")
    seen.add(task_id)
    _validate_task_routing(task, owner, task_id, execution_profiles)
    _validate_task_contracts(task, owner, task_id)


def validate_task_bundle(path: pathlib.Path) -> None:
    data = _load_object(path)
    owner = _label(path)
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(f"{owner} must contain non-empty tasks")
    execution_profiles = _execution_profiles()
    seen: set[str] = set()
    for task in tasks:
        _validate_task(task, owner, execution_profiles, seen)


def _validate_outcome_bundle_task(
    task: object,
    *,
    owner: str,
    seen: set[str],
    fixture_root: pathlib.Path,
) -> None:
    """Validate one outcome task and its repository-owned fixture reference."""
    if not isinstance(task, dict):
        raise ValueError(f"{owner} contains an invalid task: task must be an object")
    try:
        validate_outcome_task(task)
    except ValueError as exc:
        raise ValueError(f"{owner} contains an invalid task: {exc}") from exc
    task_id = str(task["task_id"])
    if task_id in seen:
        raise ValueError(f"{owner} has duplicate task_id: {task_id}")
    seen.add(task_id)
    fixture = fixture_root / task["fixture_id"]
    if not fixture.is_dir():
        raise ValueError(f"{owner} references missing fixture: {task['fixture_id']}")


def validate_outcome_bundle(path: pathlib.Path) -> None:
    """Validate an experimental task bundle without executing candidate code."""
    data = _load_object(path)
    owner = _label(path)
    if set(data) != {"benchmark_id", "status", "tasks"}:
        raise ValueError(f"{owner} fields do not match the outcome bundle contract")
    benchmark_id = data.get("benchmark_id")
    if not isinstance(benchmark_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", benchmark_id):
        raise ValueError(f"{owner} has invalid benchmark_id")
    if data.get("status") != "experimental":
        raise ValueError(f"{owner} status must be experimental")
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(f"{owner} must contain non-empty tasks")
    seen: set[str] = set()
    fixture_root = EVALS / "fixtures" / "autonomous-outcomes"
    for task in tasks:
        _validate_outcome_bundle_task(
            task,
            owner=owner,
            seen=seen,
            fixture_root=fixture_root,
        )


def validate_optimizer_campaign_file(path: pathlib.Path) -> None:
    owner = _label(path)
    try:
        campaign = validate_campaign(_load_object(path))
    except ValueError as exc:
        raise ValueError(f"{owner} is invalid: {exc}") from exc
    baseline_path = resolve_metadata_path(
        campaign["baseline_policy_path"],
        label=f"{owner} baseline_policy_path",
        contained_by=ROOT,
    )
    if not baseline_path.is_file():
        raise ValueError(f"{owner} baseline policy is missing")
    try:
        validate_policy(_load_object(baseline_path))
    except ValueError as exc:
        raise ValueError(f"{owner} baseline policy is invalid: {exc}") from exc
    for trusted_path in campaign["trusted_paths"]:
        resolved = resolve_metadata_path(
            trusted_path,
            label=f"{owner} trusted_path",
            contained_by=ROOT,
        )
        if not resolved.is_file():
            raise ValueError(f"{owner} trusted path is missing: {trusted_path}")


def _task_specs_pattern() -> re.Pattern[str]:
    schema = _load_object(EVALS / "schemas/benchmark-card.schema.json")
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise ValueError("evals/schemas/benchmark-card.schema.json is missing properties")
    task_specs_schema = properties.get("task_specs_path")
    if not isinstance(task_specs_schema, dict):
        raise ValueError(
            "evals/schemas/benchmark-card.schema.json is missing task_specs_path.pattern"
        )
    pattern = task_specs_schema.get("pattern")
    if not isinstance(pattern, str):
        raise ValueError(
            "evals/schemas/benchmark-card.schema.json is missing task_specs_path.pattern"
        )
    return re.compile(pattern)


def validate_benchmark_schema_patterns() -> None:
    pattern = _task_specs_pattern()
    for benchmark_path in iter_benchmark_paths():
        data = _load_object(benchmark_path)
        task_specs_path = data.get("task_specs_path")
        if not isinstance(task_specs_path, str) or not pattern.match(task_specs_path):
            raise ValueError(
                f"{_label(benchmark_path)} task_specs_path does not match "
                "benchmark-card schema pattern"
            )


def _require_metadata_paths(
    benchmark_paths: list[pathlib.Path],
    run_paths: list[pathlib.Path],
    task_bundle_paths: list[pathlib.Path],
) -> None:
    """Fail clearly when the release corpus omits a required metadata family."""
    required = (
        (benchmark_paths, "no benchmark cards found under evals/"),
        (run_paths, "no run cards found under evals/"),
        (task_bundle_paths, "no task bundles found under evals/"),
    )
    for paths, message in required:
        if not paths:
            raise ValueError(message)


def _validate_benchmark_set(paths: list[pathlib.Path]) -> set[tuple[str, str]]:
    """Validate benchmark cards and return unique identity/version pairs."""
    benchmarks: set[tuple[str, str]] = set()
    for path in paths:
        ref = validate_benchmark_card(path)
        if ref in benchmarks:
            raise ValueError(f"duplicate benchmark card detected for {ref[0]}@{ref[1]}")
        benchmarks.add(ref)
    return benchmarks


def main() -> int:
    """Validate every public evaluation metadata family as one release corpus."""
    benchmark_paths = iter_benchmark_paths()
    run_paths = iter_run_paths()
    task_bundle_paths = iter_task_bundle_paths()
    outcome_bundle_paths = iter_outcome_bundle_paths()
    optimizer_campaign_paths = iter_optimizer_campaign_paths()
    _require_metadata_paths(benchmark_paths, run_paths, task_bundle_paths)
    benchmarks = _validate_benchmark_set(benchmark_paths)
    for path in run_paths:
        validate_run_card(path, benchmarks)
    for path in task_bundle_paths:
        validate_task_bundle(path)
    for path in outcome_bundle_paths:
        validate_outcome_bundle(path)
    for path in optimizer_campaign_paths:
        validate_optimizer_campaign_file(path)
    validate_benchmark_schema_patterns()
    print("VERDICT: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - simple CLI path
        print(f"VERDICT: FAIL\n{exc}", file=sys.stderr)
        raise SystemExit(1) from None
