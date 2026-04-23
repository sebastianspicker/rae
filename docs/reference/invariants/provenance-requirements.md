---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: docs/research
evidence_links: ../claims/evidence-index.md
---

# Provenance Requirements

Any artifact that supports a public claim should record enough metadata to be
audited later.

## Minimum provenance

- artifact identifier
- producing module and command path
- producing model or runtime version
- benchmark or task identifier
- date or timestamp
- judge or evaluation method
- repository commit or file snapshot reference when relevant

## Strong provenance

Add these when the artifact will be compared across systems or releases:

- scenario split (`dev`, `held-out`, `stress`, `ablation`)
- cost and latency
- environment notes
- operator notes for unusual setup or exceptions
- link to benchmark card and run card

## Non-negotiable rule

If provenance is missing, the artifact may still be useful for local debugging,
but it should not be used as published evidence for a benchmark or science
claim.

## Thesis validation

This page validates the doctrine that evidence without provenance is local
signal, not publication-grade support.

## Related dossiers

- [CLM-010 reproducibility layers](../claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- provenance improves interpretability but cannot rescue a flawed sampling or
  judging procedure

## Source note

- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
