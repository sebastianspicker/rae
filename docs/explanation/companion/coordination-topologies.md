---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../science/coordination-cost.md
evidence_links: ../../reference/claims/dossiers/clm-008-coordination-topology.md
---

# Coordination Topologies

## Purpose

This companion page isolates the topology argument behind the coordination-cost
claim.

## Edge-count comparison

For $n$ active contributors:

$$
E_{\text{complete}}(n) = \frac{n(n-1)}{2}
$$

$$
E_{\text{star}}(n) = n-1
$$

The gap grows linearly for the star and quadratically for the complete graph.

## Why the topology matters

- communication effort rises with active coordination edges
- merge conflict risk rises when many contributors can modify overlapping scope
- auditability improves when responsibility boundaries stay explicit

## Related dossier

- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)

## Interpretation limits

- centralization can create bottlenecks
- all-to-all structures can still be effective for small teams and short tasks

## Source note

- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Conway 1968](../../reference/claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../../reference/claims/bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../../reference/claims/bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../../reference/claims/bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
