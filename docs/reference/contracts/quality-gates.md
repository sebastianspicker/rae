---
status: experimental
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: packages/orchestration/contracts
evidence_links: ../claims/claims-ledger.md
---

# Quality Gates

Every gate should emit a structured result with enough detail to explain:

- what was checked
- which condition failed
- whether remediation or downgrade is allowed

## Additional QC Rule

For `quality-tests`, passing test commands is not enough on its own.

The quality artifact should also expose:

- a requirement-to-test coverage ledger for MUST requirements
- a short QC summary that tells the operator whether coverage is complete,
  partial, or missing
- enough task-level context metadata to reconstruct what the QC unit actually
  loaded

This keeps the gate evidence tied to explicit requirements rather than a vague
"tests passed" narrative.

## Evidence bundle rule

Quality artifacts should carry an evidence bundle when the review burden would
otherwise fall back to manual reconstruction.

Useful evidence types include:

- `command-log`
- `trace`
- `artifact`
- `coverage-ledger`
- `qc-summary`
- `curl-transcript`
- `user-surface-probe`
- `screenshot`
- `before-after-summary`
- `risk-summary`

User-surface changes and other operator-visible behavior changes should include
visible proof such as screenshots or probe transcripts in addition to passing
commands.

Residual gaps should be written down explicitly instead of being implied by a
missing artifact.

## Thesis validation

This page validates the claim that gate logic should remain separate from
artifact structure and that progression decisions must name their evidence and
failure semantics explicitly.

## Related dossiers

- [CLM-015 contract-gate distinction](../claims/dossiers/clm-015-contract-gate-distinction.md)
- [CLM-019 validity doctrine](../claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- gate design is policy-sensitive and can be too weak or too strict if not
  benchmarked against real failure modes

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
