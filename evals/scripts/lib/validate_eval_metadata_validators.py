#!/usr/bin/env python3
"""High-level validators and CLI entrypoint for eval metadata validation."""

from __future__ import annotations

import pathlib
import re
import sys

from common import RESULTS_ROOT, is_within_directory
from router import EXECUTION_PROFILE_RUNTIMES

from lib.validate_eval_metadata_contracts import (
    BENCHMARK_SPLITS,
    BENCHMARK_STATUSES,
    CONTAMINATION_RISKS,
    EVALS,
    JUDGE_TYPES,
    PUBLICATION_STATUSES,
    ROOT,
    RUN_EVIDENCE_TYPES,
    RUN_STATUSES,
    RUNTIME_CHOICES,
    WORKFLOW_VERBS,
    iter_benchmark_paths,
    iter_run_paths,
    iter_task_bundle_paths,
    load_json,
    path_exists,
    validate_baseline_result,
    validate_delegation_contract,
    validate_judge_config,
    validate_verification_evidence,
)


def validate_benchmark_card(path: pathlib.Path) -> tuple[str, str]:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a JSON object")

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
    missing = required - set(data)
    if missing:
        missing_str = ", ".join(sorted(missing))
        raise ValueError(f"{path.relative_to(ROOT)} is missing keys: {missing_str}")

    _validate_benchmark_enums(data, path)
    _validate_benchmark_files(data, path)
    _validate_benchmark_claims(data, path)
    _validate_benchmark_regression(data, path)
    _validate_benchmark_release_gate(data, path)
    benchmark_id = str(data["benchmark_id"])
    version = str(data["version"])
    if not benchmark_id or not version:
        raise ValueError(
            f"{path.relative_to(ROOT)} benchmark_id and version must be non-empty strings"
        )
    return benchmark_id, version


def _validate_benchmark_enums(data: dict[str, object], path: pathlib.Path) -> None:
    if data["status"] not in BENCHMARK_STATUSES:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid status")
    if data["judge_type"] not in JUDGE_TYPES:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid judge_type")
    if data["contamination_risk"] not in CONTAMINATION_RISKS:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid contamination_risk")
    if data["publication_status"] not in PUBLICATION_STATUSES:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid publication_status")

    split_policy = data["split_policy"]
    if not isinstance(split_policy, list) or not split_policy:
        raise ValueError(
            f"{path.relative_to(ROOT)} split_policy must be a non-empty array"
        )
    if not set(split_policy).issubset(BENCHMARK_SPLITS):
        raise ValueError(
            f"{path.relative_to(ROOT)} split_policy contains invalid values"
        )

    failure_classes = data["failure_classes"]
    if not isinstance(failure_classes, list) or not failure_classes:
        raise ValueError(
            f"{path.relative_to(ROOT)} failure_classes must be a non-empty array"
        )



def _validate_benchmark_files(data: dict[str, object], path: pathlib.Path) -> None:
    scenario_path = ROOT / str(data["scenario_path"])
    if not scenario_path.exists():
        raise ValueError(f"{path.relative_to(ROOT)} points to a missing scenario_path")
    task_specs_path = ROOT / str(data["task_specs_path"])
    if not task_specs_path.exists():
        raise ValueError(
            f"{path.relative_to(ROOT)} points to a missing task_specs_path"
        )
    judge_path = ROOT / str(data["judge_path"])
    if not judge_path.exists():
        raise ValueError(f"{path.relative_to(ROOT)} points to a missing judge_path")
    validate_judge_config(judge_path)


def _validate_benchmark_claims(data: dict[str, object], path: pathlib.Path) -> None:
    claim_links = data["claim_links"]
    if not isinstance(claim_links, list) or not claim_links:
        raise ValueError(
            f"{path.relative_to(ROOT)} claim_links must be a non-empty array"
        )
    for claim_link in claim_links:
        if not isinstance(claim_link, str) or not path_exists(claim_link):
            raise ValueError(
                f"{path.relative_to(ROOT)} has unresolved claim_link: {claim_link}"
            )


def _validate_benchmark_regression(data: dict[str, object], path: pathlib.Path) -> None:
    regression_policy = data["regression_policy"]
    if not isinstance(regression_policy, dict):
        raise ValueError(
            f"{path.relative_to(ROOT)} regression_policy must be an object"
        )
    baselines = regression_policy.get("baseline_results")
    if not isinstance(baselines, dict) or not baselines:
        raise ValueError(
            f"{path.relative_to(ROOT)} regression_policy.baseline_results "
            "must be a non-empty object"
        )
    for split_name, baseline_path in baselines.items():
        if split_name not in BENCHMARK_SPLITS:
            raise ValueError(
                f"{path.relative_to(ROOT)} baseline_results has invalid split key: {split_name}"
            )
        if not isinstance(baseline_path, str) or not path_exists(baseline_path):
            raise ValueError(
                f"{path.relative_to(ROOT)} baseline result missing: {baseline_path}"
            )
        validate_baseline_result(ROOT / baseline_path)


def _validate_benchmark_release_gate(
    data: dict[str, object], path: pathlib.Path
) -> None:
    split_policy = data["split_policy"]
    claim_links = data["claim_links"]
    release_gate = data["release_gate"]
    if not isinstance(release_gate, dict):
        raise ValueError(f"{path.relative_to(ROOT)} release_gate must be an object")
    required_splits = release_gate.get("required_splits")
    if not isinstance(required_splits, list) or not required_splits:
        raise ValueError(
            f"{path.relative_to(ROOT)} release_gate.required_splits must be non-empty"
        )
    if not set(required_splits).issubset(BENCHMARK_SPLITS):
        raise ValueError(
            f"{path.relative_to(ROOT)} release_gate.required_splits contains invalid values"
        )
    if not set(required_splits).issubset(set(split_policy)):
        raise ValueError(
            f"{path.relative_to(ROOT)} release_gate.required_splits "
            "must be a subset of split_policy"
        )
    required_claim_links = release_gate.get("required_claim_links")
    if not isinstance(required_claim_links, list) or not required_claim_links:
        raise ValueError(
            f"{path.relative_to(ROOT)} release_gate.required_claim_links must be non-empty"
        )
    for claim_link in required_claim_links:
        if claim_link not in claim_links:
            raise ValueError(
                f"{path.relative_to(ROOT)} release_gate.required_claim_links "
                "must be included in claim_links"
            )


def validate_run_card(path: pathlib.Path, benchmarks: set[tuple[str, str]]) -> None:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a JSON object")

    required = {"run_id", "date", "system", "status"}
    missing = required - set(data)
    if missing:
        missing_str = ", ".join(sorted(missing))
        raise ValueError(f"{path.relative_to(ROOT)} is missing keys: {missing_str}")

    evidence_type = _validate_run_card_common(data, path)
    if evidence_type == "benchmark-run":
        _validate_benchmark_run(data, path, benchmarks)
    else:
        _validate_observation(data, path, evidence_type)


def _validate_run_card_common(data: dict[str, object], path: pathlib.Path) -> str:
    evidence_type = str(data.get("evidence_type", "benchmark-run"))
    if evidence_type not in RUN_EVIDENCE_TYPES:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid evidence_type")
    if data["status"] not in RUN_STATUSES:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid status")

    _validate_run_system(data, path)
    _validate_run_metadata(data, path)
    return evidence_type


def _validate_run_system(data: dict[str, object], path: pathlib.Path) -> None:
    system = data["system"]
    if not isinstance(system, dict):
        raise ValueError(f"{path.relative_to(ROOT)} system must be an object")
    for key in ("model", "runtime"):
        if not isinstance(system.get(key), str) or not system[key]:
            raise ValueError(
                f"{path.relative_to(ROOT)} system.{key} must be a non-empty string"
            )


def _validate_run_metadata(data: dict[str, object], path: pathlib.Path) -> None:
    routed_runtime = data.get("routed_runtime")
    if routed_runtime is not None and routed_runtime not in RUNTIME_CHOICES | {"mixed"}:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid routed_runtime")
    workflow_verb = data.get("workflow_verb")
    if workflow_verb is not None and workflow_verb not in WORKFLOW_VERBS:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid workflow_verb")
    if data.get("delegation_contract") is not None:
        validate_delegation_contract(
            data.get("delegation_contract"),
            f"{path.relative_to(ROOT)} delegation_contract",
        )
    if data.get("verification_evidence") is not None:
        validate_verification_evidence(
            data.get("verification_evidence"),
            f"{path.relative_to(ROOT)} verification_evidence",
        )
    for key in (
        "trace_paths",
        "artifact_paths",
        "checkpoint_paths",
        "claim_links",
        "capabilities_observed",
        "capabilities_unverified",
        "source_links",
    ):
        value = data.get(key)
        if value is not None and not isinstance(value, list):
            raise ValueError(
                f"{path.relative_to(ROOT)} {key} must be an array when present"
            )


def _validate_benchmark_run(
    data: dict[str, object],
    path: pathlib.Path,
    benchmarks: set[tuple[str, str]],
) -> None:
    required = {
        "benchmark_id", "benchmark_version", "split", "judge_version", "command", "result_path"
    }
    missing = required - set(data)
    if missing:
        raise ValueError(
            f"{path.relative_to(ROOT)} is missing benchmark-run keys: {', '.join(sorted(missing))}"
        )
    if data["split"] not in BENCHMARK_SPLITS:
        raise ValueError(f"{path.relative_to(ROOT)} has invalid split")
    benchmark_ref = (str(data["benchmark_id"]), str(data["benchmark_version"]))
    if benchmark_ref not in benchmarks:
        raise ValueError(
            f"{path.relative_to(ROOT)} references unknown benchmark "
            f"{benchmark_ref[0]}@{benchmark_ref[1]}"
        )
    result_path = (ROOT / str(data["result_path"])).resolve(strict=False)
    if not is_within_directory(result_path, RESULTS_ROOT):
        raise ValueError(f"{path.relative_to(ROOT)} result_path must point under evals/results")


def _validate_observation(
    data: dict[str, object], path: pathlib.Path, evidence_type: str
) -> None:
    required = {
        "observation_id", "observation_date", "capabilities_observed", "interpretation_limits"
    }
    missing = required - set(data)
    if missing:
        raise ValueError(
            f"{path.relative_to(ROOT)} is missing observation keys: {', '.join(sorted(missing))}"
        )
    observed = data["capabilities_observed"]
    if not isinstance(observed, list) or not observed:
        raise ValueError(
            f"{path.relative_to(ROOT)} capabilities_observed must be a non-empty array"
        )
    sources = data.get("source_links")
    if evidence_type == "vendor-doc" and (not isinstance(sources, list) or not sources):
        raise ValueError(f"{path.relative_to(ROOT)} vendor-doc observation requires source_links")


def validate_task_bundle(path: pathlib.Path) -> None:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a JSON object")
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(f"{path.relative_to(ROOT)} must contain non-empty tasks")
    task_schema = load_json(EVALS / "schemas/task-spec.schema.json")
    execution_profiles = set(task_schema["properties"]["execution_profile"]["enum"])
    seen: set[str] = set()
    for task in tasks:
        task_id = _validate_task(task, path, execution_profiles, seen)
        seen.add(task_id)


def _validate_task(
    task: object,
    path: pathlib.Path,
    execution_profiles: set[str],
    seen: set[str],
) -> str:
    if not isinstance(task, dict):
        raise ValueError(f"{path.relative_to(ROOT)} tasks entries must be objects")
    task_id = task.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError(f"{path.relative_to(ROOT)} task missing task_id")
    if task_id in seen:
        raise ValueError(f"{path.relative_to(ROOT)} duplicate task_id: {task_id}")
    if task.get("split") not in BENCHMARK_SPLITS:
        raise ValueError(f"{path.relative_to(ROOT)} task {task_id} has invalid split")
    if task.get("expected_runtime") not in RUNTIME_CHOICES:
        raise ValueError(f"{path.relative_to(ROOT)} task {task_id} has invalid expected_runtime")
    _validate_task_metadata(task, path, task_id, execution_profiles)
    claim_links = task.get("claim_links", [])
    if not isinstance(claim_links, list):
        raise ValueError(f"{path.relative_to(ROOT)} task {task_id} claim_links must be an array")
    for claim_link in claim_links:
        if not isinstance(claim_link, str) or not path_exists(claim_link):
            raise ValueError(
                f"{path.relative_to(ROOT)} task {task_id} has unresolved claim_link: {claim_link}"
            )
    return task_id


def _validate_task_metadata(
    task: dict[str, object], path: pathlib.Path, task_id: str, execution_profiles: set[str]
) -> None:
    execution_profile = task.get("execution_profile")
    if execution_profile is not None and (
        not isinstance(execution_profile, str) or execution_profile not in execution_profiles
    ):
        raise ValueError(f"{path.relative_to(ROOT)} task {task_id} has invalid execution_profile")
    if (
        execution_profile is not None
        and EXECUTION_PROFILE_RUNTIMES[execution_profile] != task["expected_runtime"]
    ):
        raise ValueError(
            f"{path.relative_to(ROOT)} task {task_id} execution_profile "
            "does not match expected_runtime"
        )
    workflow_verb = task.get("workflow_verb")
    if workflow_verb is not None and workflow_verb not in WORKFLOW_VERBS:
        raise ValueError(f"{path.relative_to(ROOT)} task {task_id} has invalid workflow_verb")
    contract = task.get("delegation_contract")
    if contract is not None:
        validate_delegation_contract(
            contract, f"{path.relative_to(ROOT)} task {task_id} delegation_contract"
        )


def validate_benchmark_schema_patterns() -> None:
    schema_path = EVALS / "schemas/benchmark-card.schema.json"
    schema = load_json(schema_path)
    if not isinstance(schema, dict):
        raise ValueError(
            "evals/schemas/benchmark-card.schema.json must be a JSON object"
        )

    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise ValueError(
            "evals/schemas/benchmark-card.schema.json is missing properties"
        )

    task_specs_schema = properties.get("task_specs_path")
    if not isinstance(task_specs_schema, dict) or not isinstance(
        task_specs_schema.get("pattern"), str
    ):
        raise ValueError(
            "evals/schemas/benchmark-card.schema.json is missing task_specs_path.pattern"
        )

    task_specs_pattern = re.compile(task_specs_schema["pattern"])
    for benchmark_path in iter_benchmark_paths():
        data = load_json(benchmark_path)
        if not isinstance(data, dict):
            raise ValueError(
                f"{benchmark_path.relative_to(ROOT)} must be a JSON object"
            )
        task_specs_path = data.get("task_specs_path")
        if not isinstance(task_specs_path, str) or not task_specs_pattern.match(
            task_specs_path
        ):
            raise ValueError(
                f"{benchmark_path.relative_to(ROOT)} task_specs_path does not match "
                "benchmark-card schema pattern"
            )


def main() -> int:
    benchmark_paths = iter_benchmark_paths()
    run_paths = iter_run_paths()
    task_bundle_paths = iter_task_bundle_paths()
    if not benchmark_paths:
        raise ValueError("no benchmark cards found under evals/")
    if not run_paths:
        raise ValueError("no run cards found under evals/")
    if not task_bundle_paths:
        raise ValueError("no task bundles found under evals/")

    benchmarks: set[tuple[str, str]] = set()
    for path in benchmark_paths:
        ref = validate_benchmark_card(path)
        if ref in benchmarks:
            raise ValueError(f"duplicate benchmark card detected for {ref[0]}@{ref[1]}")
        benchmarks.add(ref)

    for path in run_paths:
        validate_run_card(path, benchmarks)
    for path in task_bundle_paths:
        validate_task_bundle(path)
    validate_benchmark_schema_patterns()

    print("VERDICT: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - simple CLI path
        print(f"VERDICT: FAIL\n{exc}", file=sys.stderr)
        raise SystemExit(1) from exc
