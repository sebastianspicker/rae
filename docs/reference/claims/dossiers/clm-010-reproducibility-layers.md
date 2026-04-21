---
status: stable
owner: evals
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-010
---

# CLM-010 Reproducibility Layers

## Claim statement

Reproducibility in agent engineering has at least operational, benchmark, and
interpretive layers; passing one does not imply the others.

## Claim class

`engineering_heuristic`

## Proof mode

Methodological distinction grounded in reproducibility, documentation, and model
reporting literature.

## Assumptions

- command replay and interpretive agreement are separable properties
- benchmark metadata affects both rerun feasibility and result meaning
- public claims require richer reporting than local operator replay

## Internal anchors

- `docs/explanation/supplementary/reproducibility.md`
- `docs/reference/invariants/provenance-requirements.md`
- `docs/research/benchmark-protocol.md`

## External anchors

- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)

## Benchmark artifacts

- `evals/run-card.example.json`
- `evals/schemas/run-card.schema.json`

## Counterarguments

- highly standardized systems can collapse some of these layers in practice
- some local engineering tasks only need operational reproducibility

## Validity threats

- the layer boundaries are conceptual and can overlap in a real study
- interpretive reproducibility still depends on reviewer expertise

## Review status

Adopted as a documentation and evaluation doctrine.

## Source note

- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)
