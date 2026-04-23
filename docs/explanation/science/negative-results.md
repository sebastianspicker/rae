---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../research/result-report-template.md
---

# Negative Results

This repo treats negative results as first-class outputs, not embarrassment to
be hidden in commit history.

## Negative result classes

- extra orchestration added cost without measurable quality gain
- tighter determinism reduced operator flexibility too much for the task
- benchmark judge changes altered scores more than system changes did
- a polished explanation page overstated what the evidence really showed

## Publication rule

When a preferred design does not win, the result should still be preserved if
it improves future design or interpretation.

## Minimum record

- benchmark or scenario version
- compared systems or settings
- what failed to improve
- plausible reasons
- whether follow-up work is planned

## Why this matters

Negative results are part of calibration. Without them, later operators can
mistake local fashion for stable engineering guidance.

## Claim dossier

- [CLM-021 negative results](../../reference/claims/dossiers/clm-021-negative-results.md)

## Interpretation limits

- not every failed exploratory run deserves archival status
- a negative result is only useful if the setup and evidence are preserved well
  enough to interpret later

## Source note

- [Nosek open research culture](../../reference/claims/bibliography.md#src-nosek-open-research)
- [Smaldino bad science](../../reference/claims/bibliography.md#src-smaldino-bad-science)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
