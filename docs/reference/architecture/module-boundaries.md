---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../claims/assumptions-register.md
---

# Module Boundaries

## Core modules

- `packages/orchestration/`: multi-stage delivery contracts and runtimes; imported
- `packages/loops/ralph/`: deterministic story loop execution; imported
- `evals/`: evidence and benchmark infrastructure

## Supporting modules

- `profiles/agent-environments/`: sanitized public setup layer
- `tools/`: focused maintenance utilities

## Boundary rule

No module should absorb another module's identity just to reduce directory count.

## Import status

- orchestration: imported
- Ralph: imported
- coauthor trailer cleaner: imported
- public profiles: publication lane defined; sanitized payload not imported yet

## Thesis validation

This page validates the architectural claim that module identity should remain
explicit because coordination cost, maintenance burden, and source-of-truth
confusion all worsen when unrelated runtimes are collapsed artificially.

## Related dossiers

- [CLM-008 coordination topology](../claims/dossiers/clm-008-coordination-topology.md)

## Interpretation limits

- explicit module boundaries can still impose integration overhead when shared
  contracts are weak

## Source note

- [Conway 1968](../claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../claims/bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../claims/bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../claims/bibliography.md#src-cataldo-congruence)
- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
