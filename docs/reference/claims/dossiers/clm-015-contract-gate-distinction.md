---
status: stable
owner: core
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-015
---

# CLM-015 Contract-Gate Distinction

## Claim statement

Contracts and gates are distinct control surfaces; structural validity alone is
not enough to justify progression or publication.

## Claim class

`formal`

## Proof mode

Predicate-versus-decision formalization supported by verification and reporting
literature.

## Assumptions

- an artifact can satisfy schema and still be strategically weak
- progression decisions incorporate adequacy, not just structural validity
- publication claims need more than syntactic conformance

## Internal anchors

- `docs/explanation/science/contracts-and-gates.md`
- `docs/reference/contracts/quality-gates.md`
- `evals/schemas/*.json`

## External anchors

- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Diataxis](../bibliography.md#src-diataxis)

## Benchmark artifacts

None required; this claim is structural.

## Counterarguments

- lightweight workflows can merge validity and progression into one decision for
  trivial tasks
- an overly complex gate system can obscure rather than clarify responsibility

## Validity threats

- the exact gate states are implementation specific
- decision quality depends on reviewer judgment and evidence quality

## Review status

Adopted as a formal control-surface distinction.

## Source note

- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Diataxis](../bibliography.md#src-diataxis)
