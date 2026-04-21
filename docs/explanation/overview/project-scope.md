---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: README.md
evidence_links: ../../reference/architecture/system-overview.md
---

# Project Scope

RAE, short for Reliable Agentic Engineering, is a public reference implementation for studying
and operating agent workflows under stronger measurement and documentation
discipline.

## In scope

- staged orchestration for long-horizon work
- deterministic loop execution for bounded repo tasks
- narrow maintenance tools with explicit destructive boundaries
- benchmark metadata, cards, and result reporting
- scientific and governance docs that constrain public claims

## Out of scope

- claiming universal scientific laws about all agent systems
- hiding implementation uncertainty behind authoritative prose
- reporting benchmark numbers without frozen metadata
- collapsing every imported runtime into one giant binary or CLI

## Design stance

The umbrella improves on the source repos by adding:

- a shared terminology layer
- a claim and evidence discipline
- contamination-aware evaluation guidance
- release criteria that treat docs and benchmarks as product surfaces

## Thesis validation

This page carries a repo-level scope claim rather than an empirical result. Its
support comes from the package boundaries, evaluation doctrine, and the broader
literature on verification, documentation, and reproducibility.

## Related dossiers

- [CLM-017 documentation reliability](../../reference/claims/dossiers/clm-017-documentation-reliability.md)
- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- scope boundaries are governance commitments, not mathematical proofs
- later benchmark tranches can still force scope refinement

## Source note

- [Diataxis](../../reference/claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../../reference/claims/bibliography.md#src-nosek-open-research)
