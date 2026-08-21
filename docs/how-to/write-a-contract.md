---
status: stable
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../reference/contracts/artifact-schemas.md
---

# Write a Contract

A useful contract says what the artifact must be, not whether the whole task is
already good enough.

## Include

- artifact purpose
- required fields
- field semantics
- failure semantics
- provenance fields when the artifact supports claims or reporting

## Keep separate

- schema validity
- strategic adequacy
- release approval

Those belong to different layers: contract, gate, and release policy.

## Thesis validation

This page operationalizes the formal distinction between artifact contracts,
progression gates, and release approval.

## Related dossiers


## Interpretation limits

- a clear contract still depends on reviewers and downstream gates to judge
  adequacy

## Source note

- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
