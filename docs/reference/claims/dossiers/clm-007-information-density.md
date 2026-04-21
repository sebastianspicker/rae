---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-007
---

# CLM-007 Information Density

## Claim statement

Increasing context length without increasing task-relevant information can reduce
effective signal density and impair long-context performance.

## Claim class

`engineering_heuristic`

## Proof mode

Mechanistic argument supported by information theory, attention behavior, and
long-context empirical literature.

## Assumptions

- extra context often carries weakly relevant or stale material
- attention and retrieval capacity are finite even when the nominal window is
  large
- engineering performance depends on relevant context selection, not only on raw
  token budget

## Internal anchors

- `docs/explanation/science/information-theory.md`
- `docs/explanation/supplementary/formal-model.md`

## External anchors

- [Shannon 1948](../bibliography.md#src-shannon-1948)
- [Cover and Thomas](../bibliography.md#src-cover-thomas)
- [Transformer](../bibliography.md#src-transformer)
- [GPT-3](../bibliography.md#src-gpt3)
- [Kaplan scaling laws](../bibliography.md#src-kaplan-scaling)
- [Chinchilla](../bibliography.md#src-chinchilla)
- [Lost in the Middle](../bibliography.md#src-lost-in-the-middle)

## Benchmark artifacts

No frozen repo-local artifact calibrates the coefficients on this page yet.

## Counterarguments

- retrieval, compression, or phase-scoped context can improve performance even
  with large total token budgets
- some tasks genuinely benefit from broader context when relevant information is
  distributed across the sequence

## Validity threats

- the claim is explanatory rather than universally predictive
- benchmark effects depend on task structure, retrieval strategy, and model
  family

## Review status

Adopted as a scoped heuristic, not as a universal law.

## Source note

- [Shannon 1948](../bibliography.md#src-shannon-1948)
- [Cover and Thomas](../bibliography.md#src-cover-thomas)
- [Transformer](../bibliography.md#src-transformer)
- [GPT-3](../bibliography.md#src-gpt3)
- [Kaplan scaling laws](../bibliography.md#src-kaplan-scaling)
- [Chinchilla](../bibliography.md#src-chinchilla)
- [Lost in the Middle](../bibliography.md#src-lost-in-the-middle)
