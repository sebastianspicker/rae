---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/scripts/pipeline/autonomous.mjs
evidence_links: ../reference/claims/claims-ledger.md
---

# Run a Workflow 2.2 Wait

Use this procedure only with a validated local workflow whose
`schema_version` is `2.2.0` and that defines a `wait` node and matching signal
contract. Workflow 2.2 is experimental and remains a local orchestration
surface.

Start a run with the workflow path:

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --task "Perform the approved task" \
  --workflow /path/to/workflow-v2.2.json
```

When execution reaches a wait node, the scheduler persists state under
`.pipeline/runs/<run-id>/workflow/wait-state.json` and returns a waiting
result. No provider call is made for the open wait itself.

Record an accepted signal with a stable retry key and a JSON payload matching
the workflow's signal contract:

```bash
node packages/orchestration/scripts/pipeline/autonomous.mjs signal \
  --project-root /path/from/run-output \
  --run-id <run-id> \
  --node-id <wait-node> \
  --signal <signal-name> \
  --idempotency-key <stable-retry-key> \
  --payload-json '{"decision":"approve"}' \
  --json
```

Resume the same run using the workspace root printed by the original command:

```bash
./scripts/rae.sh agent resume \
  --project-root /path/from/run-output \
  --run-id <run-id>
```

The reducer consumes the earliest accepted unconsumed signal at or before the
deadline. A timeout writes a failed wait envelope, so define failure edges when
the workflow needs a controlled timeout path.

This procedure does not activate a workflow revision, publish a change, or
connect the local run to the experimental hosted platform.

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
