---
status: stable
owner: evals
last_reviewed: 2026-07-19
source_of_truth: ../../../evals/schemas/benchmark-card.schema.json
evidence_links: ../benchmark-protocol.md
---

# Benchmark Cards

Benchmark cards define the stable metadata for one benchmark family.

## Expected contents

- benchmark id and version
- family and scenario path
- split policy
- primary metric
- judge type
- contamination notes
- publication status

Use the schema in `evals/schemas/benchmark-card.schema.json` and the example in
`evals/benchmark-card.example.json`.

Maintained benchmark cards live under `evals/benchmarks/`.

## Thesis validation

Benchmark cards are the structural contract for a benchmark family. They support
interpretation only when combined with run cards, retained results, and validity
doctrine.

## Related dossiers

- [CLM-003 benchmark publication metadata](../../reference/claims/evidence-index.md#clm-003)
- [CLM-015 contract-gate distinction](../../reference/claims/dossiers/clm-015-contract-gate-distinction.md)

## Interpretation limits

- schema conformance is necessary but not sufficient for empirical adequacy

## Source note

- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
