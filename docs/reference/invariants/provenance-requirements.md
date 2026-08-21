---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../claims/evidence-index.md
---

# Provenance Requirements

Any artifact that supports a public claim should record enough metadata to be
audited later.

## Minimum provenance

- artifact identifier
- producing module and command path
- producing model or runtime version
- operation or task identifier
- date or timestamp
- verification method
- repository commit or file snapshot reference when relevant

## Strong provenance

Add these when the artifact will be compared across systems or releases:

- cost and latency
- environment notes
- operator notes for unusual setup or exceptions
- link to the relevant runtime artifact

## Non-negotiable rule

If provenance is missing, the artifact may still be useful for local debugging,
but it should not be used as published evidence for a public claim.

## Thesis validation

This page validates the doctrine that evidence without provenance is local
signal, not publication-grade support.

## Related dossiers


## Interpretation limits

- provenance improves interpretability but cannot rescue a flawed method

## Source note

- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Diataxis](../claims/bibliography.md#src-diataxis)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
