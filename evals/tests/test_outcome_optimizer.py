"""Compatibility anchor for outcome optimizer tests split by contract area.

The executable contracts live in ``test_outcome_execution_safety.py``,
``test_policy_optimizer_contracts.py``, and
``test_outcome_comparison_integrity.py``.
"""

from test_outcome_comparison_integrity import (
    test_comparison_recomputes_source_report_aggregates,
    test_default_campaign_lists_the_complete_evaluator_manifest,
    test_evaluator_manifest_binds_fixture_content_under_stable_task_ids,
    test_optimizer_requires_the_exact_campaign_manifest_without_extra_paths,
    test_paired_outcome_comparison_binds_candidate_policy_and_keeps_losses,
)
from test_outcome_execution_safety import (
    test_outcome_judge_never_falls_back_to_unsandboxed_candidate_execution,
    test_outcome_judge_never_follows_candidate_symlinks,
    test_outcome_repeat_aggregation_keeps_hard_failures_visible,
    test_outcome_task_uses_closed_judge_registry_and_detects_scope_violation,
    test_unknown_judge_case_is_rejected_before_command_execution,
)
from test_policy_optimizer_contracts import (
    test_optimizer_accepts_only_measurable_improvement_without_auto_promotion,
    test_optimizer_blocks_budgeted_campaign_when_usage_is_incomplete,
    test_optimizer_never_emits_recommendation_without_a_passing_sealed_result,
    test_optimizer_rejects_development_evidence_as_a_sealed_result,
    test_optimizer_rejects_out_of_range_reports_and_standalone_comparisons,
    test_resource_policy_rejects_unknown_token_measurement_without_zero_fill,
    test_resource_policy_with_a_limit_rejects_missing_usage_even_without_require_flag,
)

__all__ = [
    "test_comparison_recomputes_source_report_aggregates",
    "test_default_campaign_lists_the_complete_evaluator_manifest",
    "test_evaluator_manifest_binds_fixture_content_under_stable_task_ids",
    "test_optimizer_accepts_only_measurable_improvement_without_auto_promotion",
    "test_optimizer_blocks_budgeted_campaign_when_usage_is_incomplete",
    "test_optimizer_never_emits_recommendation_without_a_passing_sealed_result",
    "test_optimizer_rejects_development_evidence_as_a_sealed_result",
    "test_optimizer_rejects_out_of_range_reports_and_standalone_comparisons",
    "test_optimizer_requires_the_exact_campaign_manifest_without_extra_paths",
    "test_outcome_judge_never_falls_back_to_unsandboxed_candidate_execution",
    "test_outcome_judge_never_follows_candidate_symlinks",
    "test_outcome_repeat_aggregation_keeps_hard_failures_visible",
    "test_outcome_task_uses_closed_judge_registry_and_detects_scope_violation",
    "test_paired_outcome_comparison_binds_candidate_policy_and_keeps_losses",
    "test_resource_policy_rejects_unknown_token_measurement_without_zero_fill",
    "test_resource_policy_with_a_limit_rejects_missing_usage_even_without_require_flag",
    "test_unknown_judge_case_is_rejected_before_command_execution",
]
