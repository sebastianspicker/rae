#!/usr/bin/env python3
"""Create and resolve human checkpoint contracts for umbrella runs."""

import argparse
import pathlib

from common import dump_json, iso_timestamp, load_json, new_run_id, repo_relpath


def create_checkpoint(args: argparse.Namespace) -> int:
    checkpoint = {
        "checkpoint_id": args.checkpoint_id or new_run_id("checkpoint"),
        "run_id": args.run_id,
        "task_id": args.task_id,
        "gate_id": args.gate_id,
        "title": args.title,
        "status": "pending",
        "requested_at": iso_timestamp(),
        "requested_by": args.actor,
        "required_for": args.required_for,
        "decision": None,
        "rationale": args.rationale or "",
        "claim_links": args.claim_links,
    }
    output = pathlib.Path(args.output).resolve()
    dump_json(output, checkpoint)
    print(repo_relpath(output))
    return 0


def resolve_checkpoint(args: argparse.Namespace, decision: str) -> int:
    path = pathlib.Path(args.checkpoint).resolve()
    checkpoint = load_json(path)
    if not isinstance(checkpoint, dict):
        raise SystemExit("checkpoint file must contain a JSON object")
    checkpoint["status"] = decision
    checkpoint["decision"] = {
        "actor": args.actor,
        "at": iso_timestamp(),
        "rationale": args.rationale or "",
    }
    dump_json(path, checkpoint)
    print(repo_relpath(path))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage umbrella human checkpoint cards.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--output", required=True)
    create.add_argument("--run-id", required=True)
    create.add_argument("--task-id", required=True)
    create.add_argument("--gate-id", required=True)
    create.add_argument("--title", required=True)
    create.add_argument("--required-for", default="execution")
    create.add_argument("--actor", default="local-operator")
    create.add_argument("--rationale")
    create.add_argument("--checkpoint-id")
    create.add_argument("--claim-link", action="append", default=[], dest="claim_links")

    for decision in ("approve", "reject", "escalate"):
        resolve = subparsers.add_parser(decision)
        resolve.add_argument("--checkpoint", required=True)
        resolve.add_argument("--actor", default="local-operator")
        resolve.add_argument("--rationale")

    args = parser.parse_args()
    if args.command == "create":
        return create_checkpoint(args)
    if args.command == "approve":
        return resolve_checkpoint(args, "approved")
    if args.command == "reject":
        return resolve_checkpoint(args, "rejected")
    return resolve_checkpoint(args, "escalated")


if __name__ == "__main__":
    raise SystemExit(main())
