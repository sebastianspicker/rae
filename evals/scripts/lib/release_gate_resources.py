"""Resource-policy validation for release-gated benchmark runs."""

from typing import Any


def _resource_policy_has_limit(policy: dict[str, Any]) -> bool:
    """Report whether a policy needs a resource-usage payload to enforce a limit."""
    return any(
        policy.get(field) is not None
        for field in (
            "max_agent_duration_seconds",
            "max_agent_calls",
            "max_parallelism",
            "max_total_tokens",
        )
    )


def _scalar_resource_issues(policy: dict[str, Any], usage: dict[str, Any]) -> list[str]:
    """Compare independently measured scalar resources with their policy limits."""
    limits = (
        ("max_agent_duration_seconds", "agent_duration_seconds"),
        ("max_agent_calls", "agent_calls"),
        ("max_parallelism", "max_parallelism"),
    )
    issues: list[str] = []
    for policy_field, usage_field in limits:
        limit = policy.get(policy_field)
        value = usage.get(usage_field)
        if limit is not None and (not isinstance(value, (int, float)) or value > limit):
            issues.append(f"run card exceeds resource policy {policy_field}")
    return issues


def _total_token_issues(policy: dict[str, Any], usage: dict[str, Any]) -> list[str]:
    """Require both token counters before enforcing a combined token limit."""
    total_limit = policy.get("max_total_tokens")
    if total_limit is None:
        return []
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return ["run card lacks total-token measurement"]
    if input_tokens + output_tokens > total_limit:
        return ["run card exceeds resource policy max_total_tokens"]
    return []


def _resource_usage_state_issues(policy: dict[str, Any], usage: object) -> list[str]:
    if not isinstance(usage, dict):
        return (
            ["run card missing resource_usage"]
            if policy.get("require_measurement") or _resource_policy_has_limit(policy)
            else []
        )
    status = usage.get("measurement_status")
    if status not in {"complete", "partial", "unavailable"}:
        return ["run card has invalid resource_usage.measurement_status"]
    if policy.get("require_measurement") and status != "complete":
        return ["run card resource measurement is not complete"]
    return []


def _resource_usage_issues(benchmark: dict[str, Any], run_card: dict[str, Any]) -> list[str]:
    """Enforce an optional resource policy without treating unknown usage as zero."""
    policy = benchmark.get("resource_policy")
    if policy is None:
        return []
    if not isinstance(policy, dict):
        return ["benchmark resource_policy must be an object"]
    usage = run_card.get("resource_usage")
    issues = _resource_usage_state_issues(policy, usage)
    if not isinstance(usage, dict):
        return issues
    issues.extend(_scalar_resource_issues(policy, usage))
    issues.extend(_total_token_issues(policy, usage))
    return issues
