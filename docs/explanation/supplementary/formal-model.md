---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Formal Model

The repo’s scientific layer uses a modest formal model: enough structure to
reason about failure propagation, coordination, and evidence quality, without
pretending the full socio-technical system is analytically solved.

## Problem statement

The aim is to explain why RAE prefers staged progression, explicit gates,
bounded parallelism, and evidence-linked publication rather than one blended
agent loop.

## Definitions

- $A_k$
  Artifact produced at phase $k$.
- $G_k(A_k)$
  Gate decision over artifact $A_k$.
- $p_k$
  Probability that phase $k$ introduces or preserves a harmful defect.
- $q_k$
  Probability that phase $k$ detects a harmful defect already present.
- $B(n)$
  Benefit from using $n$ active contributors.
- $C_{\text{infer}}(n)$
  Inference or runtime cost induced by $n$ contributors.
- $C_{\text{coord}}(n)$
  Coordination cost induced by the chosen topology.

## Assumptions

- The pipeline can be abstracted as a finite ordered sequence of phases.
- Gate outputs are coarse but meaningful progression decisions.
- Defect events across phases are not perfectly independent, so the survival
  model below is heuristic rather than calibrated.
- Publication rules are governance constraints, not theorems about truth.

## Proposition 1: progression is gated rather than implicit

Treat the orchestrated system as a finite-state pipeline over phases:

$$
\mathcal{P} =
(\text{arm},
\text{design},
\text{adversarial-review},
\text{plan},
\text{pmatch},
\text{build},
\text{quality-static},
\text{quality-tests},
\text{post-build},
\text{release-readiness})
$$

Each phase emits an artifact $A_k$ and a gate result $G_k(A_k)$. The abstract
progression rule is:

$$
\operatorname{advance}(k \rightarrow k + 1)
\iff
G_k(A_k) \in \{\text{pass}, \text{acceptable-warn}\}
$$

The exact accepted gate states remain implementation-specific, but the formal
claim is that progression is mediated by an explicit decision surface rather
than by mere task completion.

## Proposition 2: staged interception multiplies defect-detection opportunities

Given $p_k$ and $q_k$, an approximate end-to-end defect survival probability is:

$$
P_{\text{survive}} \approx \prod_{k = 1}^{K} p_k (1 - q_k)
$$

This is not a calibrated estimator. It formalizes an engineering intuition:
separate gates create repeated interception opportunities, while a single loop
often compresses them into one weak detection surface.

## Proposition 3: scale-out is justified only when it beats inference and coordination cost

The coordination decision can be written as:

$$
\Delta(n) = B(n) - \lambda C_{\text{infer}}(n) - \mu C_{\text{coord}}(n)
$$

Increase $n$ only when the expected quality or throughput benefit dominates both
inference and coordination cost. This links directly to
[Coordination Cost](../science/coordination-cost.md).

## Proposition 4: publication requires more than implementation prose

Let $c$ be a public claim, $a_i$ an internal anchor, and $e_j$ an external
anchor or benchmark artifact. The governance publication rule is:

$$
\operatorname{publishable}(c)
\iff
(\exists a_i) \land ((\exists e_j) \lor \operatorname{local\_policy}(c))
$$

This prevents a common category error: treating explanatory implementation prose
as if it were empirical evidence.

## Companion and dossier links

- [CLM-007 information density](../../reference/claims/dossiers/clm-007-information-density.md)
- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)
- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [Workflow State Formalization](../companion/workflow-state-formalization.md)

## Interpretation limits

- $p_k$, $q_k$, $\lambda$, and $\mu$ are heuristic coefficients unless a
  benchmark family calibrates them explicitly.
- The model is explanatory and governance-oriented, not a proof that every RAE
  release achieves a given reliability level.
- Read this page together with
  [Threats to Validity](../science/threats-to-validity.md),
  [Limitations](../science/limitations.md), and
  [Contracts and Gates](../science/contracts-and-gates.md).

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
