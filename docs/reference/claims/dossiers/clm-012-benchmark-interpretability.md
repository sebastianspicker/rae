---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-012
---

# CLM-012 Benchmark Interpretability

## Claim statement

Benchmark outputs require explicit judge-calibration metadata and versioned
execution records to remain interpretable over time.

## Claim class

`governance_rule`

## Proof mode

Normative governance rule grounded in reproducibility doctrine; operationalised
by run-card schema requirements and the frozen-benchmark-results policy.

## Assumptions

- scores without calibration metadata cannot be reliably compared across judge
  versions or runs
- execution records must capture enough context to reconstruct the scoring
  environment
- interpretability degrades monotonically as metadata becomes stale or absent

## Internal anchors

- `evals/scripts/run_benchmark.py`
- `evals/scripts/judge_calibration.py`
- `docs/research/benchmark-protocol.md`
- `docs/research/judge-calibration.md`
- `docs/research/frozen-benchmark-results.md`

## External anchors

- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [G-Eval](../bibliography.md#src-g-eval)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)

## Benchmark artifacts

Run-cards and calibration reports are required outputs of `run_benchmark.py`;
their presence is checked by the release gate before publication.

## Counterarguments

- metadata requirements increase storage and tooling costs
- long-lived records require active curation to remain useful

## Validity threats

- versioned records do not guarantee that the environment is fully reproducible;
  external API changes can break re-execution
- calibration metadata helps interpretation but does not resolve all
  cross-version comparability questions

## Review status

Adopted as a mandatory publication requirement for all scored benchmark outputs.

## Source note

- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [G-Eval](../bibliography.md#src-g-eval)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
