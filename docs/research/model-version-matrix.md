---
status: experimental
owner: evals
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: result-report-template.md
---

# Model Version Matrix

This page records what model/runtime metadata should be preserved when the repo
publishes comparative observations or benchmarked results.

## Current state

The umbrella does not yet publish a populated cross-run comparison matrix as a
first-class artifact. Today, the source records remain:

- benchmark run cards
- regression reports
- release-gate reports
- result-ledger entries

Until a consolidated matrix is committed, use those artifact families as the
authoritative source of per-run metadata.

## Fields to preserve

- evidence type
- model
- runtime or tool adapter
- runtime version
- activity id
- reasoning effort
- benchmark family
- judge version

## Interpretation rule

The matrix exists for traceability, not ranking. If a comparison is not
like-for-like, the matrix should say so directly.

Comparative observations derived from:

- `vendor-doc`
- `operator-run`

should be labeled separately from executable `benchmark-run` rows. They are
useful for capability mapping and design comparison, but they do not carry the
same evidentiary weight as frozen benchmark artifacts.

For orchestration runs that use activity-level routing, record both the
phase-level tier and the resolved `activity_id` so later cost/quality analysis
does not collapse distinct work types into one generic phase label.

## Thesis validation

This page supports the traceability claim that comparative observations are only
interpretable when model, runtime, judge, and evidence-type fields remain
separable.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- the matrix is a reporting doctrine today, not yet a fully populated canonical
  artifact family

## Source note

- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
