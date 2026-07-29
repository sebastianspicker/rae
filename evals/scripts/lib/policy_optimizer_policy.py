"""Policy and campaign-contract validation for the offline optimizer."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
from collections.abc import Callable
from typing import Any

from common import ROOT, is_within_directory

Policy = dict[str, Any]
Evaluator = Callable[[Policy], dict[str, Any]]
Proposer = Callable[[Policy, list[dict[str, Any]]], Policy]

_POLICY_KEYS = frozenset({"schema_version", "policy_id", "phase_guidance", "phase_inputs"})
_PHASES = (
    "arm",
    "design",
    "adversarial-review",
    "plan",
    "pmatch",
    "build",
    "quality-static",
    "quality-tests",
    "post-build",
    "release-readiness",
)
_ALLOWED_INPUTS = {
    "arm": set(),
    "design": {"brief.json"},
    "adversarial-review": {"brief.json", "design.json"},
    "plan": {"brief.json", "design.json", "review.json"},
    "pmatch": {"brief.json", "design.json", "plan.json"},
    "build": {"brief.json", "design.json", "plan.json", "drift-reports/pmatch.json"},
    "quality-static": {"brief.json", "plan.json", "build.json"},
    "quality-tests": {"brief.json", "plan.json", "build.json", "quality-reports/static.json"},
    "post-build": {
        "brief.json",
        "design.json",
        "plan.json",
        "build.json",
        "quality-reports/static.json",
        "quality-reports/tests.json",
    },
    "release-readiness": {
        "brief.json",
        "design.json",
        "review.json",
        "plan.json",
        "drift-reports/pmatch.json",
        "build.json",
        "quality-reports/static.json",
        "quality-reports/tests.json",
        "quality-reports/post-build.json",
    },
}
_REQUIRED_INPUTS = {
    "arm": set(),
    "design": {"brief.json"},
    "adversarial-review": {"brief.json", "design.json"},
    "plan": {"brief.json", "design.json", "review.json"},
    "pmatch": {"brief.json", "plan.json"},
    "build": {"plan.json", "drift-reports/pmatch.json"},
    "quality-static": {"plan.json", "build.json"},
    "quality-tests": {"plan.json", "build.json"},
    "post-build": {
        "plan.json",
        "build.json",
        "quality-reports/static.json",
        "quality-reports/tests.json",
    },
    "release-readiness": {
        "review.json",
        "plan.json",
        "drift-reports/pmatch.json",
        "build.json",
        "quality-reports/static.json",
        "quality-reports/tests.json",
        "quality-reports/post-build.json",
    },
}
MAX_POLICY_GUIDANCE_BYTES = 8 * 1024
MAX_TOTAL_GUIDANCE_BYTES = 64 * 1024
MAX_CAMPAIGN_ITERATIONS = 10
MAX_OUTCOME_REPEATS = 3
MAX_TASKS_PER_REPEAT = 8
MAX_TASK_ATTEMPTS = 12
MIN_PAIRED_WINS = 2
MIN_IMPROVEMENT = 0.05


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def policy_digest(policy: Policy) -> str:
    encoded = json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def trusted_manifest(paths: list[pathlib.Path]) -> dict[str, str]:
    manifest: dict[str, str] = {}
    for path in paths:
        resolved = path.resolve()
        if not is_within_directory(resolved, ROOT):
            raise ValueError("trusted manifest paths must point under repository root")
        if not resolved.is_file():
            raise ValueError(f"trusted manifest path is not a file: {resolved}")
        manifest[resolved.relative_to(ROOT).as_posix()] = sha256_file(resolved)
    return dict(sorted(manifest.items()))


def _validate_policy_header(policy: Policy) -> tuple[dict[str, Any], dict[str, Any]]:
    if set(policy) != _POLICY_KEYS or policy.get("schema_version") != "1.0.0":
        raise ValueError("policy must exactly match the autonomous-policy schema")
    if not _is_policy_id(policy.get("policy_id")):
        raise ValueError("policy_id must be a non-empty string")
    guidance = policy.get("phase_guidance")
    inputs = policy.get("phase_inputs")
    if not isinstance(guidance, dict) or not isinstance(inputs, dict):
        raise ValueError("policy phase_guidance and phase_inputs must be objects")
    if set(guidance) != set(_PHASES) or set(inputs) != set(_PHASES):
        raise ValueError("policy must define all and only the ten autonomous phases")
    return guidance, inputs


def _is_policy_id(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", value))


def _validate_policy_guidance(guidance: dict[str, Any]) -> None:
    total_guidance = 0
    for phase, text in guidance.items():
        if (
            not isinstance(phase, str)
            or not isinstance(text, str)
            or len(text.encode()) > MAX_POLICY_GUIDANCE_BYTES
        ):
            raise ValueError("policy phase guidance is invalid or exceeds 8 KiB")
        total_guidance += len(text.encode())
    if total_guidance > MAX_TOTAL_GUIDANCE_BYTES:
        raise ValueError("policy guidance exceeds 64 KiB total")


def _validate_policy_inputs(inputs: dict[str, Any]) -> None:
    for phase, refs in inputs.items():
        if not isinstance(phase, str) or not isinstance(refs, list):
            raise ValueError("policy phase inputs are invalid")
        if (
            len(refs) != len(set(refs))
            or any(ref not in _ALLOWED_INPUTS[phase] for ref in refs)
            or not _REQUIRED_INPUTS[phase].issubset(refs)
        ):
            raise ValueError("policy phase_inputs contain unsupported artifact references")


def validate_policy(policy: Policy) -> None:
    guidance, inputs = _validate_policy_header(policy)
    _validate_policy_guidance(guidance)
    _validate_policy_inputs(inputs)


def _validate_campaign_header(campaign: object) -> dict[str, Any]:
    if not isinstance(campaign, dict):
        raise ValueError("campaign must be a JSON object")
    required = {
        "campaign_id",
        "status",
        "max_iterations",
        "baseline_policy_path",
        "trusted_paths",
    }
    allowed = required | {"resource_budget"}
    if not _has_campaign_fields(campaign, required, allowed):
        raise ValueError("campaign fields do not match the optimizer campaign contract")
    campaign_id = campaign["campaign_id"]
    if not _is_campaign_id(campaign_id):
        raise ValueError("campaign_id must be a lowercase identifier")
    if campaign["status"] != "experimental":
        raise ValueError("campaign status must be experimental")
    iterations = campaign["max_iterations"]
    if not _is_valid_iteration_count(iterations):
        raise ValueError("campaign max_iterations must be between 1 and 10")
    return campaign


def _has_campaign_fields(campaign: dict[str, Any], required: set[str], allowed: set[str]) -> bool:
    return required.issubset(campaign) and set(campaign).issubset(allowed)


def _is_campaign_id(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[a-z0-9][a-z0-9-]*", value))


def _is_valid_iteration_count(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= MAX_CAMPAIGN_ITERATIONS
    )


def _validate_campaign_paths(campaign: dict[str, Any]) -> None:
    baseline_path = campaign["baseline_policy_path"]
    if not isinstance(baseline_path, str) or not baseline_path:
        raise ValueError("campaign baseline_policy_path is required")
    trusted_paths = campaign["trusted_paths"]
    if not _are_trusted_paths(trusted_paths):
        raise ValueError("campaign trusted_paths must be unique non-empty strings")


def _are_trusted_paths(paths: Any) -> bool:
    return (
        isinstance(paths, list)
        and bool(paths)
        and all(isinstance(path, str) and path for path in paths)
        and len(paths) == len(set(paths))
    )


def _validate_campaign_budget(campaign: dict[str, Any]) -> None:
    budget = campaign.get("resource_budget")
    if budget is None:
        return
    if not _is_valid_resource_budget(budget):
        raise ValueError("campaign resource_budget must contain positive numeric limits")


def _is_valid_resource_budget(budget: Any) -> bool:
    if not isinstance(budget, dict) or not budget:
        return False
    allowed = {"max_agent_duration_seconds", "max_total_tokens", "max_agent_calls"}
    if not set(budget).issubset(allowed):
        return False
    if not _is_positive_duration(budget.get("max_agent_duration_seconds", 1)):
        return False
    return all(
        _is_positive_integer(budget.get(field, 1))
        for field in ("max_total_tokens", "max_agent_calls")
    )


def _is_positive_duration(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _is_positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_campaign(campaign: object) -> dict[str, Any]:
    validated = _validate_campaign_header(campaign)
    _validate_campaign_paths(validated)
    _validate_campaign_budget(validated)
    return validated
