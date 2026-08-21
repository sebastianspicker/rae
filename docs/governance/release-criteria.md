---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: ../reference/invariants/provenance-requirements.md
evidence_links: ../reference/invariants/provenance-requirements.md
---

# Release Criteria

`v0.1.0-alpha.1` is a proposed public alpha candidate. Interfaces may change;
the current dirty, untagged checkout is not a published release. See the root
[Release Status](https://github.com/sebastianspicker/rae/blob/main/RELEASE_STATUS.md)
and [Releasing](https://github.com/sebastianspicker/rae/blob/main/RELEASING.md)
for the current evidence boundary.

A public release is not complete unless all of the following are true:

- `./scripts/verify.sh --release-candidate` passes from a clean Git worktree
- every release-essential file is tracked in the candidate commit
- included module verification passes
- claim-bearing docs were reviewed for drift
- evidence links still resolve
- required release gates pass
- blocking checkpoints are approved

## Thesis validation

This page operationalizes the governance claim that publication requires more
than successful execution. The release surface combines verification,
provenance, and documentation review.

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
