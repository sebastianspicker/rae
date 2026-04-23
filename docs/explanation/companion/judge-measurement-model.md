---
status: stable
owner: evals
last_reviewed: 2026-04-17
source_of_truth: ../supplementary/judge-reliability.md
evidence_links: ../../reference/claims/dossiers/clm-019-validity-doctrine.md
---

# Judge Measurement Model

## Purpose

This companion page frames model judging as a measurement problem rather than an
oracle problem.

## Measurement view

Let $J_v(x)$ be the score produced by judge version $v$ on sample $x$ and let
$T(x)$ be a stronger target label. Then a usable evaluation report should track:

$$
\operatorname{Agreement}(J_v, T),
\quad
\Delta_v,
\quad
\Delta_r
$$

where $\Delta_v$ is change across judge versions and $\Delta_r$ is change across
rubric versions.

## Practical implication

If score movement is observed after either the judge or rubric changes, the repo
should avoid attributing the movement to the system under test without a
calibration check.

## Related dossiers

- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- strong agreement on one calibration set does not guarantee universal judge
  reliability
- some evaluation targets remain difficult to anchor against any stronger label

## Source note

- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [Cohen kappa](../../reference/claims/bibliography.md#src-cohen-kappa)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
