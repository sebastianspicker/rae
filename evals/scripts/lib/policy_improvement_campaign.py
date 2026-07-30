"""Validation for the evaluator-owned RAE v2 improvement campaign."""

from __future__ import annotations

from typing import Any

from lib.policy_optimizer_policy import IMPROVEMENT_CHANGE_ALLOWLIST, validate_campaign

_FROZEN_SURFACES = frozenset(
    {
        "task_matrices",
        "evaluator_and_judges",
        "runtime_envelope",
        "payload_contracts",
        "trusted_manifest",
    }
)


def validate_improvement_campaign(campaign: object) -> dict[str, Any]:
    """Require the complete v2 freeze contract before offline optimization."""
    validated = validate_campaign(campaign)
    if validated.get("campaign_version") != 2:
        raise ValueError("improvement campaign_version must be 2")
    if frozenset(validated.get("frozen_surfaces", ())) != _FROZEN_SURFACES:
        raise ValueError("improvement campaign must freeze every evaluator-owned surface")
    if frozenset(validated.get("candidate_change_allowlist", ())) != IMPROVEMENT_CHANGE_ALLOWLIST:
        raise ValueError(
            "improvement campaign candidate changes exceed the evaluator-owned allowlist"
        )
    return validated
