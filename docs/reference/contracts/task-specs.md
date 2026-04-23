---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals/schemas/task-spec.schema.json
evidence_links: ../claims/evidence-index.md
---

# Task Specs

Umbrella task routing starts from a task spec.

Canonical schema:

- `evals/schemas/task-spec.schema.json`

Canonical executable bundle:

- `evals/datasets/tool-selection/tool-selection-core.task-specs.json`

## Required fields

- `task_id`
- `title`
- `split`
- `family`
- `horizon`
- `expected_runtime`

## Routing signals

- `requires_explicit_gates`
- `requires_story_plan`
- `repo_hygiene_operation`
- `destructive_operation`
- `workflow_verb`
- `delegation_contract`

These fields let the umbrella router choose among:

- `orchestration`
- `ralph`
- `tool`

## Operational rule

Task specs are the minimum bridge between scientific benchmark design and
runtime execution. If a benchmark claim depends on runtime selection, the task
spec must make the routing-relevant signals explicit.

For non-trivial tasks, the umbrella contract can also carry a boundary-first
delegation block:

- `workflow_verb`
  One of `discover`, `plan`, `implement`, `review`, or `compound`.
- `delegation_contract.allowed_paths`
  Files or directories the delegated worker may touch.
- `delegation_contract.out_of_scope_paths`
  Explicit no-touch areas.
- `delegation_contract.dependency_task_ids`
  Task IDs that must complete first.
- `delegation_contract.verify`
  Primary success command or metric.
- `delegation_contract.guard`
  Non-regression rule and optional guard command.
- `delegation_contract.required_evidence`
  Proof types the worker must return for review.

Example:

```json
{
  "workflow_verb": "review",
  "delegation_contract": {
    "allowed_paths": ["docs/", "scripts/rae.sh"],
    "out_of_scope_paths": ["packages/loops/ralph/"],
    "dependency_task_ids": ["route-task"],
    "verify": {
      "command": "python3 evals/scripts/validate_eval_metadata.py"
    },
    "guard": {
      "rule": "doctor must stay green",
      "command": "./scripts/rae.sh doctor"
    },
    "required_evidence": [
      {
        "type": "command-log",
        "why": "show verification output"
      },
      {
        "type": "artifact",
        "why": "show resulting run cards or docs"
      }
    ],
    "fallback_rule": "escalate when scope crosses into package-local runtime behavior"
  }
}
```

## Long-Horizon Orchestration Rule

For orchestration-routed long-horizon work, routing is only the outer contract.
Execution inside the chosen runtime must still expose restartable units.

Current rule:

- build tasks should execute as fresh task sessions
- QC units should execute as fresh quality sessions
- retries should restart at the task-session boundary instead of continuing a
  polluted interaction

This keeps task specs aligned with the umbrella’s broader claim that bounded
execution units are easier to audit, retry, and benchmark than one long
conversation.

## Thesis validation

This page validates the claim that runtime routing becomes inspectable only when
task specs expose routing-relevant signals instead of burying them in prompt
text or operator memory.

## Related dossiers

- [CLM-011 runtime-selection signals](../claims/evidence-index.md#clm-011)
- [CLM-014 staged separation](../claims/dossiers/clm-014-staged-separation.md)

## Interpretation limits

- task-spec structure does not guarantee correct routing if the encoded signals
  are themselves weak or misleading

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
