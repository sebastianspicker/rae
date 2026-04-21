---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-009
---

# CLM-009 Judge Calibration

## Claim statement

Judge outputs should be treated as measurements requiring calibration and
version tracking, not as ground truth.

## Claim class

`governance_rule`

## Proof mode

Normative governance rule grounded in measurement theory; operationalised by
the RAE judge calibration protocol and G-Eval evidence on LLM scoring variance.

## Assumptions

- LLM-based judges exhibit systematic biases and inter-rater variance that must
  be tracked
- calibration must be versioned alongside judge model and prompt changes
- calibration artifacts are required metadata for any published scorecard

## Internal anchors

- `docs/research/judge-calibration.md`
- `docs/explanation/supplementary/judge-reliability.md`

## External anchors

- [G-Eval](../bibliography.md#src-g-eval)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [Model Cards](../bibliography.md#src-model-cards)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Datasheets](../bibliography.md#src-datasheets)

## Benchmark artifacts

Calibration reports are written per benchmark run by `judge_calibration.py`;
individual run artifacts are stored under `evals/results/`.

## Counterarguments

- calibration adds overhead and may not be feasible for every evaluation loop
- ground-truth judges may exist for narrow, well-specified tasks

## Validity threats

- calibration datasets may themselves be biased or unrepresentative
- drift in the judge model between calibration and production runs is not always
  detectable

## Review status

Adopted as a mandatory publication precondition for all scored evaluations.

## Source note

- [G-Eval](../bibliography.md#src-g-eval)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [Model Cards](../bibliography.md#src-model-cards)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Datasheets](../bibliography.md#src-datasheets)
