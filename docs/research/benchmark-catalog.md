---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals/scenarios
evidence_links: benchmark-protocol.md
---

# Benchmark Catalog

## Benchmark families

| Family | Status | What it measures | Primary module | Benchmark card | Dataset |
| --- | --- | --- | --- | --- | --- |
| `repo-audit` | `frozen` | deterministic audit bootstrap, route correctness, artifact completeness | Ralph | `evals/benchmarks/repo-audit-core.benchmark-card.json` | `evals/datasets/repo-audit/repo-audit-core.task-specs.json` |
| `scoped-fix` | `frozen` | bounded fix-work routing and deterministic loop bootstrap | Ralph | `evals/benchmarks/scoped-fix-core.benchmark-card.json` | `evals/datasets/scoped-fix/scoped-fix-core.task-specs.json` |
| `docs-correction` | `frozen` | documentation-task routing and deterministic loop bootstrap | Ralph | `evals/benchmarks/docs-correction-core.benchmark-card.json` | `evals/datasets/docs-correction/docs-correction-core.task-specs.json` |
| `tool-selection` | `frozen` | choosing the smallest adequate execution model | umbrella decision layer | `evals/benchmarks/tool-selection-core.benchmark-card.json` | `evals/datasets/tool-selection/tool-selection-core.task-specs.json` |
| `long-horizon` | `frozen` | staged long-horizon task routing and gated artifact emission | orchestration | `evals/benchmarks/long-horizon-core.benchmark-card.json` | `evals/datasets/long-horizon/long-horizon-core.task-specs.json` |
| `review-loop` | `experimental` | explicit explain, fix-approval, and ship review-state handling | orchestration | `evals/benchmarks/review-loop-core.benchmark-card.json` | `evals/datasets/review-loop/review-loop-core.task-specs.json` |
| `observability` | `experimental` | normalized progress-summary and operator-state emission | orchestration | `evals/benchmarks/observability-core.benchmark-card.json` | `evals/datasets/observability/observability-core.task-specs.json` |

## Catalog rule

The catalog is not a leaderboard. It is a registry of benchmark families and the
claims they are allowed to support.

## Thesis validation

The catalog validates the distinction between benchmark registration and result
interpretation. A named family is not automatically a broad empirical claim.

## Related dossiers

- [CLM-003 benchmark publication metadata](../reference/claims/evidence-index.md#clm-003)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- catalog inclusion records scope and status only
- experimental families remain capability surfaces until stronger evidence is
  frozen

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
