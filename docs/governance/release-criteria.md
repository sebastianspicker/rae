---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: ../reference/invariants/provenance-requirements.md
evidence_links: ../reference/invariants/provenance-requirements.md
---

# Release Criteria

Interfaces may change between alpha releases.

A public release is not complete unless all of the following are true:

- `npm run verify -- --release-candidate` passes from a clean Git worktree
- every release-essential file is tracked in the candidate commit
- included module verification passes
- claim-bearing docs were reviewed for drift
- evidence links still resolve
- required release gates pass
- blocking checkpoints are approved

## Thesis validation

Passing verification is not enough to publish. A release also needs provenance and
documentation review, because execution success alone says nothing about whether
an artifact is safe to ship.

## Interpretation limits

- release gates reduce publication risk; they do not guarantee universal system
  correctness

## Source note

- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Brooks no silver bullet](../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
