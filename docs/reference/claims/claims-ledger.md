---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: evidence-index.md
---

# Claims Ledger

## Claim classes

- `formal`
  Follows from a stated system model or contract.
- `engineering_heuristic`
  Strong operational guidance grounded in design or operational reasoning.
- `governance_rule`
  Normative publication or release policy.
- `implementation_reference`
  A claim whose behavioral truth is owned primarily by code, schema, or command
  surface rather than by external literature.

## Ledger

| Claim ID | Claim | Type | Status | Evidence | Dossier |
| --- | --- | --- | --- | --- | --- |
| CLM-002 | Documentation remains more maintainable when tutorial, how-to, reference, and explanation surfaces are kept distinct. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-002) | [Dossier](dossiers/clm-002-diataxis-separation.md) |
| CLM-005 | Narrow utilities belong outside the core runtime architecture when their job is explicit maintenance rather than task orchestration. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-005) | [Dossier](dossiers/clm-005-utility-placement.md) |
| CLM-007 | Increasing context length without increasing task-relevant information can reduce effective signal density and impair long-context performance. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-007) | [Dossier](dossiers/clm-007-information-density.md) |
| CLM-008 | Coordination overhead depends on communication topology; hub-and-spoke orchestration scales more favorably than unconstrained all-to-all collaboration. | formal | adopted | [Evidence Index](evidence-index.md#clm-008) | [Dossier](dossiers/clm-008-coordination-topology.md) |
| CLM-014 | Separating planning, production, and verification reduces correlated error and self-certification risk compared with a single blended loop. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-014) | [Dossier](dossiers/clm-014-staged-separation.md) |
| CLM-016 | Reasoning budget, autonomy, and review intensity should be tiered by ambiguity, consequence of error, and checkability rather than maximized uniformly. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-016) | [Dossier](dossiers/clm-016-cognitive-tiering.md) |
| CLM-017 | Documentation quality affects operator behavior and therefore belongs inside the reliability model rather than outside it. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-017) | [Dossier](dossiers/clm-017-documentation-reliability.md) |
| CLM-020 | Failure analysis is more diagnostic when representation, inference, coordination, and governance failures are separated instead of collapsed into one label. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-020) | [Dossier](dossiers/clm-020-layered-failure-model.md) |
| CLM-024 | Workflow 2.1 remains provider-neutral while execution profile 3.0 resolves explicit Codex and OpenCode routes locally; OpenCode mutation requires an isolated worktree, an exact denied-by-default tool surface, and the macOS containment backend. | implementation_reference | provisional | `packages/orchestration/contracts/workflows/execution-profile-v3.schema.json`, `packages/orchestration/scripts/pipeline/lib/opencode-adapter.mjs` | [Execution Profile 3.0](../contracts/execution-profile-v3.md) |

## Status meanings

- `adopted`
  Current repo policy or accepted modeling stance.
- `provisional`
  Plausible and useful, but awaiting stronger implementation evidence.
- `rejected`
  Found not to hold under current evidence.

## Source note

- [Diataxis](bibliography.md#src-diataxis)
- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [IEEE 1012](bibliography.md#src-ieee-1012)
- [Brooks no silver bullet](bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](bibliography.md#src-amdahl-1967)
- [IEEE 1012](bibliography.md#src-ieee-1012)
