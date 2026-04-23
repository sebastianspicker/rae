---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../science/drift-and-self-certification.md
evidence_links: ../../reference/claims/dossiers/clm-020-layered-failure-model.md
---

# Drift and Error Propagation

## Purpose

This companion page expands the science-layer intuition that defects propagate
when they survive multiple stages without interception.

## Approximate survival model

Let $p_k$ be the probability that phase $k$ preserves or introduces a harmful
defect and let $q_k$ be the probability that the phase detects a harmful defect.
An approximate survival probability is:

$$
P_{\text{survive}} \approx \prod_{k=1}^{K} p_k (1 - q_k)
$$

The expression is heuristic, but it captures why repeated gates can lower the
chance that one mistake survives to publication.

## Drift accumulation

If drift is tracked against multiple upstream artifacts, then unresolved drift
can accumulate across stages:

$$
\operatorname{Drift}_{\text{total}}(X)
=
\sum_{u \in \{D, P, R\}} \beta_u \operatorname{Drift}(u, X)
$$

where $D$ is design, $P$ is plan, and $R$ is reporting or release doctrine.

## Related dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-020 layered failure model](../../reference/claims/dossiers/clm-020-layered-failure-model.md)

## Interpretation limits

- the coefficients are not benchmark-calibrated
- phase errors are not truly independent

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
