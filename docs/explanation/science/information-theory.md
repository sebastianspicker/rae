---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Information Theory

The information-theoretic argument in this repo is simple: larger context does
not automatically mean larger useful information.

## Claim

This page supports the repo's heuristic claim that longer prompts or larger
shared context windows can degrade engineering performance when they increase
noise faster than task-relevant signal.

## Definitions

- $I$
  Human or organizational intent.
- $C$
  Context provided to the runtime.
- $S$
  Task-relevant signal inside the context.
- $N$
  Stale, weakly relevant, or irrelevant material.
- $H(C)$
  Context description length or entropy proxy.
- $\mathcal{I}(I; C)$
  Mutual information between intent and provided context.
- $\rho(C)$
  Informal relevance density, treated here as $\mathcal{I}(I; C) / H(C)$.

## Assumptions

- Additional noise contributes little new information about intent once signal is
  already present.
- Attention allocation is competitive, so irrelevant tokens can still draw mass
  away from relevant tokens.
- Longer context is a compute decision as well as a representation decision.

## Proposition 1: signal density drops when noise grows faster than intent information

Let context decompose as:

$$
C = (S, N)
$$

If $N$ contributes little new information about intent once $S$ is known, then:

$$
\mathcal{I}(I; C)
=
\mathcal{I}(I; S, N)
=
\mathcal{I}(I; S) + \mathcal{I}(I; N \mid S)
\approx
\mathcal{I}(I; S)
$$

As noise grows, $H(C)$ can increase faster than task-relevant information. A
useful proxy is:

$$
\mathrm{SNR}_{\text{info}} = \frac{\mathcal{I}(I; C)}{H(C)}
$$

Under those assumptions, growing $N$ tends to reduce effective signal density:

$$
\rho(C) = \frac{\mathcal{I}(I; C)}{H(C)}
$$

## Proposition 2: attention makes irrelevant tokens operationally costly

For query $q$ and keys $k_i$, transformer attention weights take the form:

$$
a_i = \frac{\exp(q \cdot k_i)}{\sum_j \exp(q \cdot k_j)}
$$

Adding more irrelevant tokens increases the denominator and can reduce the mass
available to relevant tokens, even when the model is theoretically capable of
processing the full sequence. A simple intuition is:

$$
\mathbb{E}\left[\sum_{i \in S} a_i\right]
\approx
\frac{|S|}{|S| + K}
$$

where $K$ is the count of additional weakly relevant or irrelevant tokens.

## Proposition 3: long context is also a compute and error-surface decision

The repo also treats long context as a computational decision. Standard
self-attention has superlinear cost in sequence length, so more context can
increase both compute and error surface.

## Practical interpretation

The operational claim is not that long context is bad. It is that context should
be curated, staged, retrieved, or compressed according to task need. The repo's
preference for scoped artifacts follows directly from that distinction.

## Engineering implication

This motivates:

- phase-scoped artifacts in orchestration
- explicit story scope in Ralph
- narrow tools for narrow maintenance tasks
- skepticism toward context accumulation as a default strategy

## Claim dossier

- [CLM-007 information density](../../reference/claims/dossiers/clm-007-information-density.md)

## Interpretation limits

- This is a heuristic and mechanistic argument, not a claim that every long
  context configuration performs worse than every short one.
- The page formalizes why context selection matters; it does not substitute for
  benchmark evidence on a specific workload.
- Read this page together with
  [Formal Model](../supplementary/formal-model.md),
  [Workflow State Formalization](../companion/workflow-state-formalization.md),
  [Threats to Validity](threats-to-validity.md), and
  [Limitations](limitations.md).

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [Cover and Thomas](../../reference/claims/bibliography.md#src-cover-thomas)
- [Transformer](../../reference/claims/bibliography.md#src-transformer)
- [GPT-3](../../reference/claims/bibliography.md#src-gpt3)
- [Kaplan scaling laws](../../reference/claims/bibliography.md#src-kaplan-scaling)
- [Chinchilla](../../reference/claims/bibliography.md#src-chinchilla)
- [Lost in the Middle](../../reference/claims/bibliography.md#src-lost-in-the-middle)
