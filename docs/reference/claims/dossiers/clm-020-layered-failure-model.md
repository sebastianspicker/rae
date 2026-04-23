---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-020
---

# CLM-020 Layered Failure Model

## Claim statement

Failure analysis is more diagnostic when representation, inference,
coordination, and governance failures are separated instead of collapsed into
one label.

## Claim class

`engineering_heuristic`

## Proof mode

Mechanistic taxonomy supported by context, coordination, evaluation, and
governance literature.

## Assumptions

- different failure layers respond to different interventions
- a single success/failure label hides actionable root causes
- the layers interact but are still separable enough to guide design

## Internal anchors

- `docs/explanation/supplementary/model-of-failure.md`
- `docs/explanation/science/drift-and-self-certification.md`

## External anchors

- [Lost in the Middle](../bibliography.md#src-lost-in-the-middle)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [G-Eval](../bibliography.md#src-g-eval)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [PaperBench](../bibliography.md#src-openai-paperbench)

## Benchmark artifacts

Failure taxonomies belong in run cards and result reports, but the repo has not
yet frozen a corpus-wide taxonomy benchmark.

## Counterarguments

- too many layers can overcomplicate debugging for small tasks
- failure categories can overlap in practice

## Validity threats

- category assignment may depend on reviewer judgment
- the taxonomy is intended for diagnosis, not for exact causal proof

## Review status

Adopted as a diagnostic heuristic.

## Source note

- [Lost in the Middle](../bibliography.md#src-lost-in-the-middle)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [G-Eval](../bibliography.md#src-g-eval)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [PaperBench](../bibliography.md#src-openai-paperbench)
