---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-005
---

# CLM-005 Utility Placement

## Claim statement

Narrow utilities belong outside the core runtime architecture when their job is
explicit maintenance rather than task orchestration.

## Claim class

`engineering_heuristic`

## Proof mode

Structural argument from module-boundary doctrine; operationalised by the
separation of `tools/repo-hygiene/` from the core `packages/` surface.

## Assumptions

- the boundary between "maintenance utility" and "orchestration primitive" is
  identifiable from the tool's primary call site
- moving a utility outside core does not remove it from the verification
  contract; it receives its own test suite
- re-inlining is acceptable when a utility becomes load-bearing for task
  orchestration

## Internal anchors

- `tools/repo-hygiene/coauthor-trailer-cleaner/README.md`
- `docs/reference/architecture/module-boundaries.md`
- `profiles/agent-environments/README.md`

## External anchors

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)

## Benchmark artifacts

None required for an engineering heuristic operating at architecture scope.

## Counterarguments

- placement decisions can be subjective when a utility straddles maintenance and
  orchestration concerns
- separate placement increases discovery friction for new contributors

## Validity threats

- the heuristic depends on stable boundary definitions; architectural drift can
  make utilities look like primitives over time
- verification coverage gaps are possible when utilities live outside the main
  CI surface

## Review status

Adopted as a scoped module-boundary heuristic.

## Source note

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [Conway 1968](../bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../bibliography.md#src-brooks-no-silver-bullet)
- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)
