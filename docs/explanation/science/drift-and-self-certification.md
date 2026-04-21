---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Drift and Self-Certification

Drift is divergence between intent, design, plan, implementation, and reported
state. Self-certification is the special case where the same production process
also acts as the only verifier.

## Claim

This page supports the claim that staged separation reduces correlated error and
that layered failure analysis is more useful than a single undifferentiated
"agent failed" label.

## 1. Drift as constraint violation

Let `C(D)` be the set of material constraints implied by design artifact `D`.
Then a weighted drift score can be written as:

$$
\operatorname{Drift}(D, X) =
\frac{\sum_{c \in C(D)} w_c \cdot \mathbf{1}[\neg c(X)]}{\sum_{c \in C(D)} w_c}
$$

where `X` is the realized implementation.

This is not a claim that all constraints are machine-extractable today. It is a
useful model for why plan/design/implementation separation matters.

## 2. Why self-certification is dangerous

If the same process both produces `X` and certifies it, then the error modes of
production and evaluation become correlated rather than independent.

A simple reliability sketch is:

$$
P_{\text{miss}} \approx P(E_p \cap E_v)
$$

where $E_p$ is production error and $E_v$ is verification failure. If the same
surface drives both, the joint miss probability can remain high even when local
confidence is high.

That increases the chance of:

- unnoticed omissions
- internally consistent but externally wrong solutions
- weak benchmark reports with no independent pressure test

## 3. Repo implication

The umbrella counters this with:

- staged artifacts
- adversarial review
- explicit drift matching
- separate benchmark and documentation governance

## Companion surfaces

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-020 layered failure model](../../reference/claims/dossiers/clm-020-layered-failure-model.md)
- [Drift and Error Propagation](../companion/drift-error-propagation.md)

## Interpretation limits

- not all constraints are machine-extractable today
- staged workflows reduce some correlated error modes but can still share blind
  spots or weak rubrics
- the formulas here are explanatory, not calibrated field estimates

## Source note

- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
