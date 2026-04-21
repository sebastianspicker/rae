---
status: experimental
owner: core
last_reviewed: 2026-04-17
source_of_truth: AGENTS.md
evidence_links: claims/evidence-index.md
---

# Workflow Rubric

This page defines the umbrella operating model for reusable workflow assets.

## Canonical verbs

- `discover`
  Read, route, and collect context without changing the repo.
- `plan`
  Declare the execution boundary before implementation.
- `implement`
  Make the scoped change.
- `review`
  Verify the result with evidence, not only command exit codes.
- `compound`
  Turn repeated human corrections into reusable repo memory.

## Delegation rubric

Every non-trivial workflow asset should make the following explicit:

- `boundary`
  Allowed paths, out-of-scope paths, and fallback rules.
- `dependencies`
  Upstream tasks, artifacts, or checkpoints that must already exist.
- `verify`
  The primary success command, probe, or metric.
- `guard`
  The non-regression rule that must stay green.
- `evidence`
  The proof bundle required for review.
- `ownership`
  Which doc, command, or package remains source of truth.
- `resumability`
  The state artifact or path needed to resume the work.

## Admission rubric for commands, skills, agents, and docs

Promote a reusable asset only when all of the following are true:

- it solves a repeated workflow rather than a one-off prompt
- the boundary is narrow enough to review quickly
- success and regression checks are explicit
- required evidence is named up front
- ownership and review cadence are clear
- the asset composes with worktree-isolated execution

Reject or keep-local an asset when any of the following are true:

- it hides a destructive action behind a generic name
- it depends on oral tradition instead of a contract
- it has no measurable verify or guard step
- it duplicates a stronger package-local source of truth

## Decision table

| Task shape | Primary verb | Runtime | Minimum evidence |
| --- | --- | --- | --- |
| Narrow explicit maintenance | `implement` | `tool` | command log, touched artifact summary |
| Story-sized deterministic audit/fix | `plan` then `implement` | `ralph` | command log, scoped artifacts, residual risk note when unresolved |
| Multi-phase or gate-heavy execution | `plan` then `review` | `orchestration` | trace, artifact bundle, gate summary, guard result |
| User-surface change | `review` | runtime-dependent | screenshot or probe transcript plus command evidence |
| Repeated human correction | `compound` | docs or narrow tool | updated memory or rubric entry |

## Source-of-truth rule

Use package-local docs for runtime behavior. Use umbrella docs for integration,
evidence policy, release criteria, and claims about the system as a whole.

## Thesis validation

This rubric validates the workflow thesis that reusable assets should declare
boundary, verification, guard, and evidence up front instead of relying on oral
tradition.

## Related dossiers

- [CLM-014 staged separation](claims/dossiers/clm-014-staged-separation.md)
- [CLM-015 contract-gate distinction](claims/dossiers/clm-015-contract-gate-distinction.md)

## Interpretation limits

- the rubric is a governance heuristic and can be too heavy for trivial tasks

## Source note

- [Diataxis](claims/bibliography.md#src-diataxis)
- [IEEE 1012](claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](claims/bibliography.md#src-nist-genai-profile)
- [Anthropic effective agents](claims/bibliography.md#src-anthropic-effective-agents)
- [Model Cards](claims/bibliography.md#src-model-cards)
- [Datasheets](claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](claims/bibliography.md#src-pineau-reproducibility)
