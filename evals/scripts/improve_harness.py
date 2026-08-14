#!/usr/bin/env python3
"""Run a bounded evaluator-owned RAE v2 improvement campaign from sealed evidence."""

from __future__ import annotations

import argparse

from common import load_json
from lib.policy_improvement_campaign import validate_improvement_campaign
from optimize_harness import _path
from optimize_harness import main as optimize_main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True)
    args, _unknown = parser.parse_known_args()
    try:
        validate_improvement_campaign(load_json(_path(args.campaign, "campaign")))
    except ValueError as exc:
        raise SystemExit(f"invalid improvement campaign: {exc}") from exc
    return optimize_main()


if __name__ == "__main__":
    raise SystemExit(main())
