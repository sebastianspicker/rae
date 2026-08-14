---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/contracts/workflows/workflow-v2.2.schema.json
evidence_links: ../claims/claims-ledger.md
---

# Workflow 2.2 Contract

Workflow 2.2 is an experimental local scheduler contract for durable waits and
operator signals. It is separate from the experimental hosted platform. The
local scheduler requires a durable run directory and is selected only for a
workflow whose `schema_version` is `2.2.0`.

## Schema shape

A workflow declares an identifier, revision, entry and terminal nodes, nodes,
edges, and at least one signal contract. Nodes may be `agent`, `join`, `gate`,
`checkpoint`, `wait`, or `terminal`. A wait node declares a timeout from 60
seconds through 30 days, its accepted signal names, and the signal contract
that validates a recorded payload.

Budgets constrain concurrency to 1 through 4, attempts per node to 1 through
3, and context to 16 KiB through 256 KiB. The default context cap is 128 KiB.
The immutable node envelope records input and output digests, an execution
tier, evidence fields, and a context manifest with included, omitted, inline,
and referenced inputs.

## Context assembly

The scheduler orders mandatory context as task, node guidance, mapped item,
and predecessor records. It either includes a complete predecessor object or
an immutable artifact reference. If mandatory material cannot fit, scheduling
fails before a provider call. Operational evidence, verified graph records,
and admitted memory are optional and require explicit policy permission and
budget.

This is a bounded-context implementation property. It does not establish a
context-efficiency benefit. A frozen comparison with a predefined 25 percent
threshold remains required before any efficiency claim can be made.

## Wait state

Wait signals are persisted under
`.pipeline/runs/<run-id>/workflow/wait-state.json`. Signal recording is
idempotent per wait node and idempotency key. On resume, the reducer consumes
the earliest accepted unconsumed signal at or before the wait deadline. A wait
does not invoke a provider while it is open. A timed-out wait creates a failed
node envelope and follows failure edges when the workflow defines them.

Workflow 2.2 does not migrate stored 2.0 or 2.1 runs or private registries.
Use [Run a Workflow 2.2 Wait](../../how-to/run-workflow-v2.2-wait.md) and
[Recover a Workflow 2.2 Wait](../../how-to/recover-workflow-v2.2-wait.md) for
local operations.

## Source note

- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Diataxis](../claims/bibliography.md#src-diataxis)
