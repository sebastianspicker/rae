---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: editorial
evidence_links: ../reference/claims/claims-ledger.md
---

# Choose an Execution Model

## Use orchestration when

- the task is long-horizon
- intake, design, build, and release checks should be separated
- explicit artifacts and gates matter more than speed
- the work should run in an isolated worktree or under explicit supervision

Primary surfaces:

- `./scripts/rae.sh agent run ...` for autonomous code, tests, docs, and gates
- `./scripts/rae.sh orchestrate ...`
- `./scripts/rae.sh workflow long-horizon ...`
- `./scripts/rae.sh worktree ...`

## Use Ralph when

- the work can be expressed as story-sized units
- deterministic ordering and atomic state updates matter
- audit, linting, and fixing should be mode-separated

Primary surfaces:

- `./scripts/rae.sh ralph ...`
- `./scripts/rae.sh workflow repo-audit ...`

## Use a tool under `tools/` when

- the operation is narrow and explicit
- it should not be mistaken for the main execution architecture
- destructive behavior must stay obvious

Primary surface today:

- `./scripts/rae.sh hygiene coauthor-cleaner ...`

## Escalation rule

Start with the smallest adequate structure. Move to a more complex execution
model only when the task needs its additional ownership, artifact, or gate
controls.

## Decision table

| If the task is mainly... | Use | Default verb | Minimum proof |
| --- | --- | --- | --- |
| explicit maintenance with narrow scope | `tool` | `implement` | command log and artifact summary |
| deterministic audit/fix with story-sized scope | `ralph` | `plan` then `implement` | command log and scoped artifacts |
| gated multi-phase execution without model invocation | `orchestrate` | `plan` then `review` | trace, artifact bundle, verify command, guard result |
| autonomous implementation | `agent run` | `implement` then `review` | isolated diff, agent-call trace, gates, run report, documentation report |
| long-horizon implementation work | `agent run` in default worktree mode | `implement` then `review` | isolated workspace metadata and progress summary |
| user-surface or high-risk change | runtime-dependent | `review` | screenshot or probe transcript plus command evidence |

The full reusable-asset rubric lives in
[`../reference/workflow-rubric.md`](../reference/workflow-rubric.md).

## Thesis validation

This page operationalizes the repo thesis that operators should start with the
smallest adequate execution structure and escalate only when complexity buys
auditability, quality, or reproducibility.

## Related dossiers

- [CLM-008 coordination topology](../reference/claims/dossiers/clm-008-coordination-topology.md)
- [CLM-014 staged separation](../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-016 cognitive tiering](../reference/claims/dossiers/clm-016-cognitive-tiering.md)

## Interpretation limits

- runtime choice remains a heuristic routing problem, not an exact optimizer

## Source note

- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [Conway 1968](../reference/claims/bibliography.md#src-conway-1968)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../reference/claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../reference/claims/bibliography.md#src-endsley-situation-awareness)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
