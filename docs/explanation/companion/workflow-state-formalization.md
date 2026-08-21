---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../supplementary/formal-model.md
evidence_links: ../../reference/claims/dossiers/clm-014-staged-separation.md
---

# Workflow State Formalization

## Purpose

This companion page gives the science layer a compact workflow-state model so
the main articles can stay readable.

## State space

Let the workflow be a labeled transition system:

$$
\mathcal{W} = (S, \Sigma, T, s_0)
$$

where $S$ is the set of states, $\Sigma$ the transition labels, $T$ the allowed
transitions, and $s_0$ the entry state.

For the umbrella science model, a useful abstract state sequence is:

$$
S = (\text{intake}, \text{design}, \text{plan}, \text{build}, \text{verify}, \text{publish})
$$

## Gate-mediated progression

Progression is allowed only when the outgoing artifact satisfies the local gate:

$$
(s_k \rightarrow s_{k+1}) \in T
\iff
G_k(A_k) \in \{\text{pass}, \text{acceptable-warn}\}
$$

This formalizes the distinction between doing work and being allowed to advance.

## Why the model matters

- it makes stage separation explicit
- it exposes where self-certification can occur
- it creates a home for artifact, gate, and evidence traceability

## Related dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)

## Interpretation limits

- real workflows can loop, branch, or pause more than this simplified model
- accepted gate states remain implementation-specific

## Source note

- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
