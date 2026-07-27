---
status: stable
owner: science
last_reviewed: 2026-07-19
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-014
---

# CLM-014 Staged Separation

## Claim statement

Separating planning, production, and verification reduces correlated error and
self-certification risk compared with a single blended loop.

## Claim class

`engineering_heuristic`

## Proof mode

Mechanistic argument supported by verification doctrine, evaluation practice,
and failure-analysis literature.

## Assumptions

- producer and verifier failures are not perfectly independent, but role
  separation still changes the error surface
- task artifacts can be inspected between stages
- the added process cost is justified when consequence of error is material

## Internal anchors

- `docs/explanation/science/problem-statement.md`
- `docs/explanation/science/drift-and-self-certification.md`
- `packages/orchestration/scripts/pipeline/runner.mjs`
- `packages/orchestration/scripts/pipeline/autonomous.mjs`
- `packages/orchestration/scripts/pipeline/tests/autonomous-core-scenarios.test.mjs`
- `packages/orchestration/scripts/pipeline/tests/autonomous-checkpoint-scenarios.test.mjs`

## External anchors

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)

## Benchmark artifacts

The autonomous integration regression proves stage separation, actual target
mutation, plan-ownership blocking, and independent gate progression on a local
fixture. Targeted model-quality ablation studies remain pending.

## Counterarguments

- for low-risk tasks the staging overhead can outweigh quality gains
- the same team may still carry correlated blind spots across stages

## Validity threats

- the claim is about risk reduction, not guaranteed correctness
- measured gains can depend on artifact quality and review rigor

## Review status

Adopted as a scoped engineering heuristic.

## Source note

- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
