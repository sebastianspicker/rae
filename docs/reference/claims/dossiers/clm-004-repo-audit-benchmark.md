---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-004
---

# CLM-004 Repo Audit Benchmark

## Claim statement

On the frozen repo-audit benchmark family, the deterministic loop surface
preserves full success, route accuracy, artifact completeness, and checkpoint
compliance on dev and held-out splits.

## Claim class

`empirical`

## Proof mode

Frozen benchmark run-cards on dev and held-out splits; regression gate blocks
on score degradation across the four reported dimensions.

## Assumptions

- the task suite and grading rubric are fixed at benchmark freeze
- the Ralph loop is the sole runner; no competing runtime surfaces exist
- determinism contracts (seed, temperature, tool pinning) are enforced
  throughout the run

## Internal anchors

- `packages/loops/ralph/README.md`
- `docs/reference/invariants/determinism-contracts.md`
- `evals/benchmarks/repo-audit-core.benchmark-card.json`
- `evals/results/baselines/repo-audit-core-dev.json`
- `evals/results/baselines/repo-audit-core-held-out.json`

## External anchors

- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)

## Benchmark artifacts

- `evals/results/baselines/repo-audit-core-dev.json`
- `evals/results/baselines/repo-audit-core-held-out.json`

## Counterarguments

- a frozen benchmark cannot capture distribution shift in real-world repos
- the four dimensions may not exhaust relevant quality axes

## Validity threats

- scores reflect the current Ralph implementation; model or tool changes can
  break determinism contracts and invalidate historical baselines
- held-out tasks were authored in the same environment as dev tasks, which may
  introduce correlated coverage gaps

## Review status

Adopted as empirical grounding for the deterministic loop design.

## Source note

- [PaperBench](../bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)
