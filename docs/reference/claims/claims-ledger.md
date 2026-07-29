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
- `empirical`
  Requires benchmark or experimental evidence.
- `engineering_heuristic`
  Strong operational guidance that may rely on design or operational reasoning
  rather than a dedicated frozen benchmark.
- `governance_rule`
  Normative publication or release policy.
- `implementation_reference`
  A claim whose behavioral truth is owned primarily by code, schema, or command
  surface rather than by external literature.

## Ledger

| Claim ID | Claim | Type | Status | Evidence | Dossier |
| --- | --- | --- | --- | --- | --- |
| CLM-002 | Documentation remains more maintainable when tutorial, how-to, reference, and explanation surfaces are kept distinct. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-002) | [Dossier](dossiers/clm-002-diataxis-separation.md) |
| CLM-003 | Benchmark results are not publishable without frozen task, split, runtime, and judge metadata. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-003) | [Dossier](dossiers/clm-003-benchmark-provenance.md) |
| CLM-004 | On the frozen repo-audit benchmark family, the deterministic loop surface preserves full success, route accuracy, artifact completeness, and checkpoint compliance on dev and held-out splits. | empirical | adopted | [Evidence Index](evidence-index.md#clm-004) | [Dossier](dossiers/clm-004-repo-audit-benchmark.md) |
| CLM-005 | Narrow utilities belong outside the core runtime architecture when their job is explicit maintenance rather than task orchestration. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-005) | [Dossier](dossiers/clm-005-utility-placement.md) |
| CLM-006 | Public coding benchmarks require contamination-aware interpretation and should not be treated as sufficient evidence in isolation. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-006) | [Dossier](dossiers/clm-006-benchmark-contamination.md) |
| CLM-007 | Increasing context length without increasing task-relevant information can reduce effective signal density and impair long-context performance. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-007) | [Dossier](dossiers/clm-007-information-density.md) |
| CLM-008 | Coordination overhead depends on communication topology; hub-and-spoke orchestration scales more favorably than unconstrained all-to-all collaboration. | formal | adopted | [Evidence Index](evidence-index.md#clm-008) | [Dossier](dossiers/clm-008-coordination-topology.md) |
| CLM-009 | Judge outputs should be treated as measurements requiring calibration and version tracking, not as ground truth. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-009) | [Dossier](dossiers/clm-009-judge-calibration.md) |
| CLM-010 | Reproducibility in agent engineering has at least operational, benchmark, and interpretive layers; passing one does not imply the others. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-010) | [Dossier](dossiers/clm-010-reproducibility-layers.md) |
| CLM-011 | Task specs should make runtime-selection signals explicit so routing decisions remain inspectable instead of implicit. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-011) | [Dossier](dossiers/clm-011-explicit-routing.md) |
| CLM-012 | Benchmark outputs require explicit judge-calibration metadata and versioned execution records to remain interpretable over time. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-012) | [Dossier](dossiers/clm-012-benchmark-interpretability.md) |
| CLM-013 | Claim-bearing benchmark publication requires an explicit release gate that blocks on regressions, evidence gaps, or unresolved checkpoints. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-013) | [Dossier](dossiers/clm-013-release-gate.md) |
| CLM-014 | Separating planning, production, and verification reduces correlated error and self-certification risk compared with a single blended loop. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-014) | [Dossier](dossiers/clm-014-staged-separation.md) |
| CLM-015 | Contracts and gates are distinct control surfaces; structural validity alone is not enough to justify progression or publication. | formal | adopted | [Evidence Index](evidence-index.md#clm-015) | [Dossier](dossiers/clm-015-contract-gate-distinction.md) |
| CLM-016 | Reasoning budget, autonomy, and review intensity should be tiered by ambiguity, consequence of error, and checkability rather than maximized uniformly. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-016) | [Dossier](dossiers/clm-016-cognitive-tiering.md) |
| CLM-017 | Documentation quality affects operator behavior and therefore belongs inside the reliability model rather than outside it. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-017) | [Dossier](dossiers/clm-017-documentation-reliability.md) |
| CLM-019 | Reliability and benchmark claims require explicit threats-to-validity, contamination, and uncertainty analysis before publication-strength interpretation. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-019) | [Dossier](dossiers/clm-019-validity-doctrine.md) |
| CLM-020 | Failure analysis is more diagnostic when representation, inference, coordination, and governance failures are separated instead of collapsed into one label. | engineering_heuristic | adopted | [Evidence Index](evidence-index.md#clm-020) | [Dossier](dossiers/clm-020-layered-failure-model.md) |
| CLM-021 | Negative results should be preserved as first-class evidence when they constrain interpretation, calibration, or future design. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-021) | [Dossier](dossiers/clm-021-negative-results.md) |
| CLM-022 | Graph-informed repository context should remain experimental until it improves localization or reduces context under frozen held-out evaluation without reducing task passes or crossing repository and protected-path boundaries. | governance_rule | adopted | [Evidence Index](evidence-index.md#clm-022) | [Graph Contract](../contracts/graph-memory.md#experimental-status) |

## Status meanings

- `adopted`
  Current repo policy or accepted modeling stance.
- `provisional`
  Plausible and useful, but still awaiting stronger benchmark evidence.
- `rejected`
  Found not to hold under current evidence.

## Source note

- [Diataxis](bibliography.md#src-diataxis)
- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [OpenAI evals guidance](bibliography.md#src-openai-evals)
- [PaperBench](bibliography.md#src-openai-paperbench)
- [IEEE 1012](bibliography.md#src-ieee-1012)
