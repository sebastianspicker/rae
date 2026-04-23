---
status: stable
owner: evals
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../reference/invariants/provenance-requirements.md
---

# Result Report Template

Every published result report should include the following sections.

## Metadata

- benchmark identifier and version
- run identifier
- scenario split
- model and runtime versions
- environment or platform capture needed for reproduction
- judge and rubric versions
- judge calibration summary or explicit statement that calibration is not yet
  available
- comparison baseline or explicit statement that no baseline applies

## Benchmark question

- benchmark question
- benchmark intent or hypothesis
- why this benchmark family is the right measurement surface for that question

## Results

- headline metrics
- sample counts and exclusions when relevant
- failure class summary
- cost and latency
- uncertainty or error-analysis summary when applicable, or explicit statement
  that the metric is descriptive only

## Required interpretation block

Every report should answer:

- what was measured
- what was not measured
- what changed relative to the comparison point
- what contamination, judge, or external-validity risks remain
- whether the surrounding claim should be read as empirical, heuristic, or
  purely local policy

## Required reproducibility block

- exact artifacts needed to reproduce the reported result
- retained evidence for user-visible behavior such as screenshots, probes, or
  traces when applicable
- residual uncertainty that should follow the result into downstream summaries

## Thesis validation

This template operationalizes the claim that result publication must distinguish
measurement from interpretation and preserve the evidence needed to revisit that
interpretation later.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)
- [CLM-021 negative results](../reference/claims/dossiers/clm-021-negative-results.md)

## Interpretation limits

- a good report template cannot rescue a weak benchmark design or weak judge
  calibration

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../reference/claims/bibliography.md#src-artstein-poesio)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
