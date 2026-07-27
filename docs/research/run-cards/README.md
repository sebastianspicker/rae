---
status: stable
owner: evals
last_reviewed: 2026-07-19
source_of_truth: ../../../evals/schemas/run-card.schema.json
evidence_links: ../result-report-template.md
---

# Run Cards

Run cards define the metadata for one concrete benchmark execution.

The same schema also supports comparative runtime observations that are not
benchmark executions. Use the `evidence_type` field to distinguish:

- `benchmark-run`
- `operator-run`
- `vendor-doc`

## Expected contents for `benchmark-run`

- run id
- benchmark id and benchmark version
- split
- system metadata
- judge version
- result path
- cost and latency

Use the schema in `evals/schemas/run-card.schema.json` and the example in
`evals/run-card.example.json`.

Release-gate run cards are emitted by the frozen benchmark suite into temporary or
CI-managed output roots under `evals/results/` and must satisfy the
release-gate requirements before their results are cited.

Comparative observation cards should record:

- observation id and date
- observed capabilities
- interpretation limits
- source links for vendor-doc evidence

These cards are useful for planning and comparison, but they should not be
quoted as if they were benchmark results.

## Thesis validation

Run cards make one execution auditable. They validate provenance and evidence
type, but broader claims still depend on calibration, validity, and comparison
logic.

## Related dossiers

- [CLM-010 reproducibility layers](../../reference/claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- a run card can truthfully describe a weak run; honest metadata does not imply
  benchmark strength by itself

## Source note

- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
