---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: docs/research
evidence_links: ../research/result-report-template.md
---

# Reproduce a Result

To reproduce a result in this repo, you need more than a score.

## Required inputs

- benchmark id and version
- run id
- scenario split
- runtime and model versions
- judge version
- command path or script entrypoint
- result artifact path

## Reproduction rule

If any of those are missing, the result may still be informative, but it is not
fully reproducible in the sense this repo aims for.

## Current practical path

- use package-local commands for execution
- store benchmark metadata in `evals/`
- link the resulting artifact from the report or claim-bearing page

## Thesis validation

This page operationalizes the repo thesis that reproducibility requires more
than a score and must include the metadata needed to reconstruct both execution
and interpretation.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- full reproducibility can still fail if dependencies, provider input, or judge logic
  drift outside the recorded artifact bundle

## Source note

- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
