---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: ../../research/benchmark-protocol.md
evidence_links: ../../reference/invariants/provenance-requirements.md
---

# Reproducibility

Reproducibility in agent engineering has at least three layers.

## 1. Operational reproducibility

Can another operator run the same command surface and obtain the same class of
artifacts?

This depends on:

- commands
- config
- repository state
- runtime dependencies

## 2. Benchmark reproducibility

Can another evaluator rerun the benchmark with the same:

- tasks
- split
- judge
- runtime versions
- result reporting rules

## 3. Interpretive reproducibility

Would another competent reader draw the same conclusion from the result?

This depends on:

- whether failure classes are explicit
- whether limitations are stated
- whether contamination risk is discussed

## Repo implication

A result can be operationally reproducible but interpretively misleading. That
is why this repo pairs run metadata with claim, evidence, and limitation pages
instead of treating command replay as sufficient.

## Claim dossier

- [CLM-010 reproducibility layers](../../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- these layers overlap in real workflows
- reproducibility does not imply correctness or external validity

## Source note

- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../../reference/claims/bibliography.md#src-nosek-open-research)
