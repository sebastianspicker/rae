---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: ../../research/judge-calibration.md
evidence_links: ../../reference/claims/evidence-index.md
---

# Judge Reliability

Model judges are measurement instruments with failure modes, not oracle layers.

## 1. Reliability dimensions

Judge reliability has at least four components:

- agreement with stronger references or trained human review
- sensitivity to rubric wording
- stability across judge model versions
- calibration by failure class

## 2. Basic measurement view

Let `J(x)` be the judge output for sample `x` and `T(x)` the stronger target
label or reference judgment. Then reliability is not only about raw agreement:

$$
\operatorname{reliability}(J)
\sim
\big(P(J(x)=T(x)), \operatorname{Var}_{x}, \operatorname{Var}_{v}, \operatorname{Var}_{r}\big)
$$

where the variance terms capture sample-class, judge-version, and rubric drift.

## 3. Why this matters for LLM evaluation

A model-judge stack can drift in at least two ways:

- the system under test changes
- the judge changes

If those are not disentangled, apparent performance movement may be judge drift
rather than system improvement.

## 4. Repo policy implication

This is why benchmarked results in this repo should record:

- judge identifier
- judge version
- rubric version
- calibration set when available

## Related surfaces

- [Judge Measurement Model](../companion/judge-measurement-model.md)
- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Source note

- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [Cohen kappa](../../reference/claims/bibliography.md#src-cohen-kappa)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
