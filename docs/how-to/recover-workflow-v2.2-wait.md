---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/scripts/pipeline/lib/workflow-v22-reducer.mjs
evidence_links: ../reference/claims/claims-ledger.md
---

# Recover a Workflow 2.2 Wait

Workflow 2.2 recovery is local and applies only to its durable wait state. It
does not recover a hosted worker, PostgreSQL lease, or object-store transfer.

1. Keep the original workspace and run directory intact. The wait state is at
   `.pipeline/runs/<run-id>/workflow/wait-state.json`.
2. Use the original run ID, workspace root, wait-node name, signal name, and
   idempotency key when retrying a signal. Replaying the same node and key is a
   no-op.
3. Resume the run with `./scripts/rae.sh agent resume --project-root <workspace>
   --run-id <run-id>`.
4. Inspect the wait state and immutable node envelopes before another signal or
   a retry. The scheduler only consumes accepted signals recorded on or before
   the wait deadline.

If the deadline passed, the resumed scheduler creates a failed wait envelope.
Recovery then follows the workflow's failure edges, if any. Do not edit the
wait-state file to force progress. The reducer checks the run and workflow
digest against the immutable snapshot and fails when the state is busy or does
not match.

The tested recovery case is a local signal and resume flow. Container restart,
PostgreSQL failover, OIDC token refresh, S3 transfer recovery, and remote worker
recovery remain unverified integration work.

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
