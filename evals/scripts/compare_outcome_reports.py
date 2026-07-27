#!/usr/bin/env python3
"""Compare paired autonomous outcome reports for the policy optimizer."""

import argparse
import pathlib

from common import RESULTS_ROOT, ROOT, dump_json, is_within_directory, load_json
from lib.outcome_eval import compare_outcome_reports


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--challenger", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def _path(value: str, label: str) -> pathlib.Path:
    candidate = pathlib.Path(value)
    path = (ROOT / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    if not is_within_directory(path, ROOT):
        raise SystemExit(f"{label} must be under repository root")
    return path


def main() -> int:
    args = _args()
    output = _path(args.output, "output")
    if not is_within_directory(output, RESULTS_ROOT):
        raise SystemExit("output must be under evals/results")
    if output.exists():
        raise SystemExit("output already exists; comparison evidence is immutable")
    baseline = load_json(_path(args.baseline, "baseline"))
    challenger = load_json(_path(args.challenger, "challenger"))
    if not isinstance(baseline, dict) or not isinstance(challenger, dict):
        raise SystemExit("outcome reports must be JSON objects")
    try:
        comparison = compare_outcome_reports(baseline, challenger)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    dump_json(output, comparison)
    print(output.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
