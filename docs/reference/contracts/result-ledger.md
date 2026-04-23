---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals/schemas/result-ledger-entry.schema.json
evidence_links: ../claims/evidence-index.md
---

# Result Ledger

The unified result ledger links:

- benchmark runs
- per-task routing decisions
- runtime traces
- emitted artifacts
- checkpoint cards
- claim-bearing docs

Canonical artifact:

- `result-ledger.jsonl`

Schema:

- `evals/schemas/result-ledger-entry.schema.json`

## Entry kinds

- `benchmark-run`
- `task-result`

## Purpose

The ledger is the machine-readable bridge between execution and publication.
Without it, claims about a run remain hard to audit because traces, artifacts,
and claim pages drift apart.

## Thesis validation

This page validates the traceability claim that publication-strength evidence
needs one machine-readable bridge across runs, artifacts, checkpoints, and docs.

## Related dossiers

- [CLM-010 reproducibility layers](../claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- a ledger improves traceability but cannot make a weak benchmark or weak claim
  strong on its own

## Source note

- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
