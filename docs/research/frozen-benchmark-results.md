---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals
evidence_links: benchmark-catalog.md
---

# Frozen Benchmark Results

This repository ships a frozen umbrella benchmark suite rerun during
`./scripts/verify.sh`.

## Frozen suite benchmark families

| Family | Benchmark card | Dataset | Dev baseline | Held-out baseline |
| --- | --- | --- | --- | --- |
| tool-selection | `evals/benchmarks/tool-selection-core.benchmark-card.json` | `evals/datasets/tool-selection/tool-selection-core.task-specs.json` | `evals/results/baselines/tool-selection-core-dev.json` | `evals/results/baselines/tool-selection-core-held-out.json` |
| long-horizon | `evals/benchmarks/long-horizon-core.benchmark-card.json` | `evals/datasets/long-horizon/long-horizon-core.task-specs.json` | `evals/results/baselines/long-horizon-core-dev.json` | `evals/results/baselines/long-horizon-core-held-out.json` |
| repo-audit | `evals/benchmarks/repo-audit-core.benchmark-card.json` | `evals/datasets/repo-audit/repo-audit-core.task-specs.json` | `evals/results/baselines/repo-audit-core-dev.json` | `evals/results/baselines/repo-audit-core-held-out.json` |
| docs-correction | `evals/benchmarks/docs-correction-core.benchmark-card.json` | `evals/datasets/docs-correction/docs-correction-core.task-specs.json` | `evals/results/baselines/docs-correction-core-dev.json` | `evals/results/baselines/docs-correction-core-held-out.json` |
| scoped-fix | `evals/benchmarks/scoped-fix-core.benchmark-card.json` | `evals/datasets/scoped-fix/scoped-fix-core.task-specs.json` | `evals/results/baselines/scoped-fix-core-dev.json` | `evals/results/baselines/scoped-fix-core-held-out.json` |

These five families are executed for `dev` and `held-out` splits in the root
verification flow. The committed baseline artifacts require perfect
success-rate, route-accuracy, artifact-completeness, and checkpoint-compliance
for those two production splits.

## Executable experimental families

The repo also ships two executable control-surface families that are not part of
the frozen production suite:

| Family | Status | Dev baseline | Held-out baseline |
| --- | --- | --- | --- |
| review-loop | `experimental` | `evals/results/baselines/review-loop-core-dev.json` | `evals/results/baselines/review-loop-core-held-out.json` |
| observability | `experimental` | `evals/results/baselines/observability-core-dev.json` | `evals/results/baselines/observability-core-held-out.json` |

These surfaces are useful for validating explicit runtime contracts, but they
should be cited as experimental capability surfaces rather than settled public
claims.

## Publication rule

Claim-bearing documentation may cite these frozen artifacts directly, but
should still state whether the cited evidence is:

- a route-and-artifact benchmark
- a deterministic loop benchmark
- an experimental control-surface benchmark (for example review-loop or observability)
- a governance or contamination rule informed by external literature

Experimental benchmark surfaces may exist before a broader empirical claim is
adopted. When that happens, the benchmark should be cited as a capability
surface, not as a settled public claim.

## Thesis validation

This page validates only the existence and status of frozen benchmark artifacts.
Interpretation of those artifacts remains conditional on benchmark design,
judge behavior, contamination handling, and explicit claim scope.

## Related dossiers

- [CLM-004 frozen repo-audit evidence](../reference/claims/evidence-index.md#clm-004)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- perfect committed baselines do not imply universal robustness outside the
  frozen families and their splits

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../reference/claims/bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
