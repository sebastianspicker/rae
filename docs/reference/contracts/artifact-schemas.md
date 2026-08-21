---
status: experimental
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: packages/orchestration/contracts
evidence_links: ../claims/evidence-index.md
---

# Artifact Schemas

Artifact schemas live under `packages/orchestration/contracts/`.

Public rule:

- contracts must define structure
- gates must define acceptance logic
- reporting artifacts must carry provenance when they support public claims

Current imported schema set includes:

- brief
- design document
- review report
- review loop
- execution plan
- drift report
- progress summary
- quality report
- release readiness
- execution trace
- graph manifest, node, edge, context bundle, and memory decision
- graph-native workflow 2.0 and immutable node-result envelope 2.0
- graph-native workflow and node-instance envelope 2.1
- operator-owned execution profile with economy, standard, and judgment tiers
- graph-native workflow and immutable node-result envelope 2.2

Version 2.1 adds bounded maps, item streams, allowlisted transforms, threshold
joins, typed failure collection, until-dry convergence, and immutable instance
identity. Version 2.0 remains a separate accepted contract for existing run
snapshots and locally activated revisions. RAE does not rewrite private
registries or migrate stored runs automatically.

Version 2.2 adds local durable wait nodes, typed signal contracts, bounded
context manifests, and immutable references for predecessor records that do
not fit inline. It is experimental and does not connect the local scheduler to
the hosted platform. See [Workflow 2.2 Contract](workflow-v2.2.md).

## Interpretation limits

- schema validity can still coexist with weak or misleading content

## Source note

- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Diataxis](../claims/bibliography.md#src-diataxis)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
- [Diataxis](../claims/bibliography.md#src-diataxis)
