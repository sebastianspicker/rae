---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: ../reference/invariants/provenance-requirements.md
evidence_links: ../research/benchmark-protocol.md
---

# Release Criteria

A public release is not complete unless all of the following are true:

- umbrella verification passes
- imported module verification passes
- claim-bearing docs were reviewed for drift
- benchmark metadata validates
- evidence links still resolve
- required benchmark regressions pass
- required release gates pass
- blocking checkpoints are approved

## Additional gate for benchmarked releases

If a release contains benchmark claims, it must also include:

- benchmark card
- run card
- result ledger
- regression report
- release gate report
- judge version
- split designation
- failure summary
- cost and latency metadata
- verification evidence summary with any residual gaps called out explicitly

## Thesis validation

This page operationalizes the governance claim that publication requires more
than successful execution. The release surface combines verification,
provenance, benchmark integrity, and documentation review.

## Related dossiers

- [CLM-013 release gate doctrine](../reference/claims/evidence-index.md#clm-013)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- release gates reduce publication risk; they do not guarantee universal system
  correctness

## Source note

- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
