---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-011
---

# CLM-011 Explicit Routing

## Claim statement

Task specs should make runtime-selection signals explicit so routing decisions
remain inspectable instead of implicit.

## Claim class

`governance_rule`

## Proof mode

Normative governance rule operationalised by the task-spec contract and the
router implementation; grounded in auditability doctrine.

## Assumptions

- routing decisions have material consequences for quality and cost
- implicit routing (e.g., based on heuristics buried in the runner) is harder
  to audit, reproduce, and modify
- the task-spec schema is the canonical surface for runtime-selection signals

## Internal anchors

- `scripts/rae.sh`
- `evals/scripts/router.py`
- `docs/reference/contracts/task-specs.md`

## External anchors

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Toolformer](../bibliography.md#src-toolformer)

## Benchmark artifacts

None required; this is an architectural governance rule.

## Counterarguments

- making routing explicit adds authoring overhead to task spec creation
- some routing signals are genuinely emergent and hard to specify ahead of time

## Validity threats

- explicit signals in specs can become stale if runtime selection logic changes
  without updating the spec contract
- inspectability depends on the signal vocabulary being well-defined and stable

## Review status

Adopted as a mandatory task-spec authoring requirement.

## Source note

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Toolformer](../bibliography.md#src-toolformer)
