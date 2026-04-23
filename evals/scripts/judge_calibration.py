#!/usr/bin/env python3
"""Run calibration for the umbrella's programmatic judge."""

from __future__ import annotations

import argparse
import pathlib
from typing import Any

from common import dump_json, iso_timestamp, load_json, metric_ratio, repo_relpath


def judge_case(case: dict[str, Any]) -> str:
    route_ok = bool(case.get("route_ok", True))
    command_ok = bool(case.get("command_ok", True))
    artifacts_ok = bool(case.get("artifacts_ok", True))
    checkpoint_ok = bool(case.get("checkpoint_ok", True))
    return "pass" if route_ok and command_ok and artifacts_ok and checkpoint_ok else "fail"


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibrate the programmatic judge against gold cases.")
    parser.add_argument("--judge-config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    config_path = pathlib.Path(args.judge_config).resolve()
    config = load_json(config_path)
    cases = config.get("calibration_cases", [])
    if not isinstance(cases, list) or not cases:
        raise SystemExit("judge config must contain non-empty calibration_cases")

    records = []
    matches = 0
    for case in cases:
        actual = judge_case(case)
        expected = case["expected_verdict"]
        matched = actual == expected
        matches += int(matched)
        records.append(
            {
                "case_id": case["case_id"],
                "expected_verdict": expected,
                "actual_verdict": actual,
                "matched": matched,
            }
        )

    report = {
        "judge_id": config["judge_id"],
        "judge_version": config["judge_version"],
        "rubric_version": config["rubric_version"],
        "calibrated_at": iso_timestamp(),
        "calibration_case_count": len(records),
        "agreement_rate": metric_ratio(matches, len(records)),
        "known_blind_spots": config.get("known_blind_spots", []),
        "cases": records,
    }
    output = pathlib.Path(args.output).resolve()
    dump_json(output, report)
    print(repo_relpath(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
