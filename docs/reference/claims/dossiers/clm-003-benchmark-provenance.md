---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-003
---

# CLM-003 Benchmark Provenance

## Claim statement

Benchmark results are not publishable without frozen task, split, runtime, and
judge metadata.

## Claim class

`governance_rule`

## Proof mode

Normative governance rule operationalised by schema contracts and publication
policy; supported by reproducibility doctrine.

## Assumptions

- benchmark metadata is captured at run time and stored alongside results
- the benchmark-card and run-card schemas are the authoritative metadata
  surfaces
- publication is gated on schema validation and ledger entry

## Internal anchors

- `docs/research/benchmark-protocol.md`
- `evals/schemas/benchmark-card.schema.json`
- `evals/schemas/run-card.schema.json`

## External anchors

- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination and flawed tests](../bibliography.md#src-openai-swebench-verified)

## Benchmark artifacts

Schema compliance is checked by `validate_eval_metadata.py` on every run; no
frozen scorecard artifact is needed for a governance rule.

## Counterarguments

- strict provenance requirements add process overhead for rapid iteration
- some metadata fields may be hard to freeze before a benchmark matures

## Validity threats

- schema compliance does not guarantee semantic correctness of captured metadata
- frozen metadata may become stale if runtime or judge versions are not pinned

## Review status

Adopted as a mandatory publication precondition.

## Source note

- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination and flawed tests](../bibliography.md#src-openai-swebench-verified)
