#!/usr/bin/env python3
"""Run one bounded, offline experimental policy-optimizer campaign from evidence files."""

import argparse
import pathlib

from common import RESULTS_ROOT, ROOT, is_within_directory, load_json
from lib.policy_optimizer import (
    optimize_campaign,
    policy_digest,
    validate_campaign,
    validate_policy,
)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True)
    parser.add_argument("--baseline-evaluation", required=True)
    parser.add_argument("--candidate-policy", required=True, action="append")
    parser.add_argument("--candidate-evaluation", required=True, action="append")
    parser.add_argument("--sealed-evaluation", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def _path(value: str, label: str) -> pathlib.Path:
    candidate = pathlib.Path(value)
    path = candidate.resolve() if candidate.is_absolute() else (ROOT / candidate).resolve()
    if not is_within_directory(path, ROOT):
        raise SystemExit(f"{label} must be under repository root")
    return path


def _campaign_and_output(args: argparse.Namespace) -> tuple[dict, pathlib.Path]:
    try:
        campaign = validate_campaign(load_json(_path(args.campaign, "campaign")))
    except ValueError as exc:
        raise SystemExit(f"invalid campaign: {exc}") from exc
    output_dir = _path(args.output_dir, "output-dir")
    if not is_within_directory(output_dir, RESULTS_ROOT):
        raise SystemExit("output-dir must be under evals/results")
    return campaign, output_dir


def _campaign_inputs(
    args: argparse.Namespace, campaign: dict
) -> tuple[dict, list[dict], dict, list[dict], dict]:
    baseline = load_json(_path(campaign["baseline_policy_path"], "baseline_policy_path"))
    candidates = [load_json(_path(path, "candidate-policy")) for path in args.candidate_policy]
    baseline_evaluation = load_json(_path(args.baseline_evaluation, "baseline-evaluation"))
    evaluations = [
        load_json(_path(path, "candidate-evaluation")) for path in args.candidate_evaluation
    ]
    sealed = load_json(_path(args.sealed_evaluation, "sealed-evaluation"))
    if len(candidates) != len(evaluations):
        raise SystemExit("candidate-policy and candidate-evaluation counts must match")
    if len(candidates) < int(campaign["max_iterations"]):
        raise SystemExit("campaign max_iterations exceeds the supplied candidate count")
    if not all(
        isinstance(value, dict)
        for value in (baseline, baseline_evaluation, sealed, *candidates, *evaluations)
    ):
        raise SystemExit("policy and evaluation inputs must be JSON objects")
    return baseline, candidates, baseline_evaluation, evaluations, sealed


def _validate_policies(baseline: dict, candidates: list[dict]) -> None:
    try:
        validate_policy(baseline)
        for candidate in candidates:
            validate_policy(candidate)
    except ValueError as exc:
        raise SystemExit(f"invalid policy: {exc}") from exc
    policy_ids = [baseline["policy_id"], *(candidate["policy_id"] for candidate in candidates)]
    if len(policy_ids) != len(set(policy_ids)):
        raise SystemExit("baseline and candidate policy_id values must be unique")


def _normalized_evaluation(value: dict, policy: dict) -> dict:
    aggregate = value.get("aggregate", value)
    if not isinstance(aggregate, dict):
        raise SystemExit("evaluation aggregate must be a JSON object")
    normalized = dict(value)
    normalized.update(aggregate)
    normalized["policy_id"] = value.get("policy_id", normalized.get("policy_id"))
    normalized["policy_digest"] = value.get("policy_digest", normalized.get("policy_digest"))
    for field in (
        "evidence_type",
        "benchmark_id",
        "split",
        "task_matrix_digest",
        "repeat_count",
        "task_attempt_count",
        "evaluator_manifest",
        "evaluator_manifest_digest",
    ):
        normalized[field] = value.get(field, normalized.get(field))
    if normalized["policy_id"] != policy["policy_id"]:
        raise SystemExit("evaluation policy_id does not match its policy")
    if normalized["policy_digest"] != policy_digest(policy):
        raise SystemExit("evaluation policy_digest does not match its policy")
    return normalized


def _run_campaign(
    campaign: dict,
    output_dir: pathlib.Path,
    baseline: dict,
    candidates: list[dict],
    baseline_evaluation: dict,
    evaluations: list[dict],
    sealed: dict,
) -> dict:

    baseline_evidence = _normalized_evaluation(baseline_evaluation, baseline)
    candidate_evidence = {
        candidate["policy_id"]: _normalized_evaluation(evaluation, candidate)
        for candidate, evaluation in zip(candidates, evaluations, strict=True)
    }

    def evaluate(policy: dict) -> dict:
        if policy["policy_id"] == baseline["policy_id"]:
            return baseline_evidence
        try:
            return candidate_evidence[policy["policy_id"]]
        except KeyError as exc:
            raise ValueError(f"no evaluation supplied for policy: {policy['policy_id']}") from exc

    return optimize_campaign(
        baseline_policy=baseline,
        proposer=lambda _incumbent, lineage: candidates[len(lineage)],
        evaluator=evaluate,
        sealed_evaluator=lambda policy: _normalized_evaluation(sealed, policy),
        trusted_paths=[_path(path, "trusted_path") for path in campaign["trusted_paths"]],
        output_dir=output_dir,
        max_iterations=int(campaign["max_iterations"]),
        resource_budget=campaign.get("resource_budget"),
    )


def main() -> int:
    args = _args()
    campaign, output_dir = _campaign_and_output(args)
    baseline, candidates, baseline_evaluation, evaluations, sealed = _campaign_inputs(
        args, campaign
    )
    _validate_policies(baseline, candidates)
    report = _run_campaign(
        campaign, output_dir, baseline, candidates, baseline_evaluation, evaluations, sealed
    )
    print((output_dir / "campaign-report.json").relative_to(ROOT).as_posix())
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
