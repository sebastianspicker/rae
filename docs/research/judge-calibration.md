---
status: experimental
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals/judges
evidence_links: ../reference/claims/evidence-index.md
---

# Judge Calibration

Judges should be treated as instruments that can drift, not as invisible truth
machines.

## Calibration questions

- How often does the judge agree with gold references or human review?
- Which failure classes are over- or under-detected?
- What changes when the judge model or rubric changes?

## Minimum calibration record

- judge identifier and version
- rubric version
- calibration set identifier
- agreement summary
- known blind spots
- executable calibration artifact

## Current harness surface

Run calibration with:

```bash
./scripts/rae.sh eval calibrate \
  --judge-config evals/judges/programmatic-router-judge.json \
  --output evals/results/local-dev/judge-calibration.json
```

## Operational rule

If a result depends heavily on a model judge, the run card should make that
dependency explicit.

## Thesis validation

This page validates the claim that judges are measurement instruments requiring
agreement checks, version tracking, and rubric-aware interpretation.

## Related surfaces

- [Judge Reliability](../explanation/supplementary/judge-reliability.md)
- [Judge Measurement Model](../explanation/companion/judge-measurement-model.md)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- the current harness is real, but calibration evidence remains experimental
  until a stronger frozen reference set is committed

## Source note

- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [Cohen kappa](../reference/claims/bibliography.md#src-cohen-kappa)
- [Artstein and Poesio](../reference/claims/bibliography.md#src-artstein-poesio)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
