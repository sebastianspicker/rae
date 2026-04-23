---
status: experimental
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: packages/orchestration/contracts
evidence_links: ../claims/evidence-index.md
---

# Artifact Schemas

Artifact schemas live under `packages/orchestration/contracts/`.

Public rule:

- contracts must define structure
- gates must define acceptance logic
- reporting artifacts must carry provenance when they support benchmark or science claims

Current imported schema set includes:

- brief
- design document
- review report
- review loop
- execution plan
- drift report
- progress summary
- quality report
- release readiness
- execution trace

Umbrella eval/runtime schemas additionally include:

- `evals/schemas/task-spec.schema.json`
- `evals/schemas/checkpoint-card.schema.json`
- `evals/schemas/benchmark-card.schema.json`
- `evals/schemas/run-card.schema.json`
- `evals/schemas/regression-report.schema.json`
- `evals/schemas/result-ledger-entry.schema.json`

The `run-card` schema serves two related but distinct roles:

- executable `benchmark-run` metadata
- comparative runtime observations (`operator-run`, `vendor-doc`)

Interpretation remains evidence-type dependent. A contract-valid run card is not
automatically benchmark evidence.

## Thesis validation

This page validates the structural claim that schemas define artifact shape,
while adequacy and publication strength remain separate questions.

## Related dossiers

- [CLM-015 contract-gate distinction](../claims/dossiers/clm-015-contract-gate-distinction.md)

## Interpretation limits

- schema validity can still coexist with weak or misleading content

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [Diataxis](../claims/bibliography.md#src-diataxis)
