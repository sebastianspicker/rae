---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: evals/schemas/checkpoint-card.schema.json
evidence_links: ../claims/evidence-index.md
---

# Human Checkpoints

Umbrella-level human checkpoints are explicit runtime contracts, not informal
operator notes.

Schema:

- `evals/schemas/checkpoint-card.schema.json`

CLI:

- `./scripts/rae.sh checkpoint create ...`
- `./scripts/rae.sh checkpoint approve ...`
- `./scripts/rae.sh checkpoint reject ...`
- `./scripts/rae.sh checkpoint escalate ...`

## Status model

- `pending`
- `approved`
- `rejected`
- `escalated`

## Use cases

- approve a risky runtime route before execution
- reject publication for unresolved evidence gaps
- escalate destructive maintenance actions
- confirm a focused fix before mutation begins
- explicitly approve the ship transition after review

## Release rule

If a benchmark or release gate declares `block_on_pending_checkpoints: true`,
every referenced checkpoint must be `approved` before publication can pass.

## Review Loop Rule

Explain, fix, and ship should not share the same approval semantics.

- explain is read-only by default
- fix requires explicit confirmation before mutation
- ship requires explicit approval before release closure

Where the runtime emits a review-loop artifact, these states should be visible
as explicit status transitions rather than inferred from free-form chat.

## Thesis validation

This page validates the governance claim that risky transitions should be gated
by explicit human acknowledgment rather than inferred approval.

## Related dossiers

- [CLM-015 contract-gate distinction](../claims/dossiers/clm-015-contract-gate-distinction.md)
- [CLM-019 validity doctrine](../claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- checkpoints add friction and should be reserved for meaningful risk or release
  decisions

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../claims/bibliography.md#src-endsley-situation-awareness)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
