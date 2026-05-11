---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Coordination Cost

Additional agents or reviewers help only when the quality gain exceeds the
coordination tax they create.

## Claim

This page supports the formal claim that coordination overhead depends on
communication topology, so architecture determines whether extra contributors
help or harm.

## Definitions

- $n$
  Number of active contributors, reviewers, or workers.
- $E_{\text{complete}}(n)$
  Edge count in a fully connected interaction graph.
- $E_{\text{star}}(n)$
  Edge count in a hub-and-spoke interaction graph.
- $C_{\text{coord}}(n)$
  Coordination cost under a chosen topology.
- $B(n)$
  Benefit from parallel contributors.

## Assumptions

- Communication overhead grows with the number of active coordination edges.
- The lead runtime can serialize or merge worker output rather than requiring
  unrestricted all-to-all discussion.
- Benefit from more contributors is bounded and can saturate.

## Proposition 1: topology changes the scaling law

For $n$ contributors in a fully connected interaction graph, the number of
communication edges is:

$$
E_{\text{complete}}(n) = \frac{n(n - 1)}{2}
$$

For a hub-and-spoke structure:

$$
E_{\text{star}}(n) = n - 1
$$

If the average coordination cost per edge is $\alpha > 0$, then:

$$
C_{\text{coord}}^{\text{complete}}(n)
\approx
\alpha \frac{n(n - 1)}{2}
$$

$$
C_{\text{coord}}^{\text{star}}(n)
\approx
\alpha (n - 1)
$$

That difference is architectural, not cosmetic.

## Proposition 2: parallelization is justified only when net benefit stays positive

The orchestration rationale uses the decision pattern:

$$
\Delta(n) = B(n) - \lambda C_{\text{infer}}(n) - \mu C_{\text{coord}}(n)
$$

Use parallelization only when `Delta(n)` remains meaningfully positive.

## Proposition 3: topology changes the failure surface, not only the budget

When the interaction graph is unconstrained, merge conflicts, contradictory
recommendations, and duplicated work also rise. In RAE terms, topology affects
both cost and diagnosability.

## Why this matters

Without explicit topology and fan-out limits, systems can:

- duplicate work
- generate contradictory findings
- require expensive adjudication
- create false impressions of robustness because many agents were involved

## Repo implication

The umbrella favors:

- hub-and-spoke orchestration
- bounded reviewer and builder counts
- deterministic loops where one active story is the main unit of progress

## Claim dossier

- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)

## Interpretation limits

- The equations describe scaling pressure, not a universal coefficient that is
  already benchmark-calibrated for every task family.
- Small all-to-all collaborations can still be useful for short, low-risk work;
  the point is that unconstrained fan-out should not be the default.
- Read this page together with
  [Formal Model](../supplementary/formal-model.md),
  [Coordination Topologies](../companion/coordination-topologies.md), and
  [Contracts and Gates](contracts-and-gates.md).

## Source note

- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Conway 1968](../../reference/claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../../reference/claims/bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../../reference/claims/bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../../reference/claims/bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
