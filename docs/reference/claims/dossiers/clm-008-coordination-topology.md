---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-008
---

# CLM-008 Coordination Topology

## Claim statement

Coordination overhead depends on communication topology; hub-and-spoke
orchestration scales more favorably than unconstrained all-to-all
collaboration.

## Claim class

`formal`

## Proof mode

Graph-based scaling argument supported by socio-technical coordination
literature.

## Assumptions

- coordination cost rises with active communication edges and merge burden
- not all contributors need direct pairwise coordination
- quality gain from more contributors can saturate before merge cost does

## Internal anchors

- `docs/explanation/science/coordination-cost.md`
- `packages/orchestration/docs/ORCHESTRATION_POLICY.md`

## External anchors

- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)

## Benchmark artifacts

No frozen umbrella benchmark currently fits a topology-ablation estimate.

## Counterarguments

- small all-to-all review can outperform centralized routing on short, ambiguous
  work
- serial bottlenecks can appear if the coordinator becomes overloaded

## Validity threats

- edge count is an explanatory proxy rather than a calibrated cost model
- communication quality matters alongside topology

## Review status

Adopted as a formal design argument with uncalibrated coefficients.

## Source note

- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
