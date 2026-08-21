---
status: stable
owner: loops
last_reviewed: 2026-04-12
source_of_truth: packages/loops/ralph
evidence_links: ../claims/claims-ledger.md
---

# Determinism Contracts

Determinism here does not mean identical semantic outcomes across all models.
It means the control surface around execution is explicit and auditable.

## Required properties

- story or task selection order is explicit
- state mutations are atomic
- report paths are predictable and confined
- retries are bounded and observable
- mode changes are explicit
- safety checks happen in code, not only in provider instructions

## Why it matters

Deterministic control surfaces make failures easier to reproduce, compare, and
benchmark. They also reduce the chance that a loop appears reliable only
because it is hard to inspect.

## Thesis validation

This page validates the narrower determinism claim used by RAE: not identical
semantic outputs, but explicit and auditable control flow around execution.

## Related dossiers


## Interpretation limits

- deterministic control does not remove model stochasticity or guarantee perfect
  task outcomes

## Source note

- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
