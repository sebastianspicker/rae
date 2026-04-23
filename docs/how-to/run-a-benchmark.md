---
status: stable
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals
evidence_links: ../research/benchmark-protocol.md
---

# Run a Benchmark

This repo’s benchmark layer is executable. The required workflow is:

1. choose a benchmark card
2. execute one split through the umbrella harness
3. inspect the run card, result file, calibration report, regression report,
   and release gate
4. publish only if the release gate passes

Benchmark output roots must live under `evals/results/`. The run-card contract
uses repo-relative result paths, so arbitrary external output directories are
not valid publication surfaces.

Some executable families remain intentionally experimental and are not part of
the frozen production suite. In that case, the benchmark surface is real, but
broader public claim promotion still waits for ablation coverage and stricter
review.

## Comparative runtime observations

Not every runtime record in `evals/` is a benchmark run.

The run-card schema supports three evidence types:

- `benchmark-run`
- `operator-run`
- `vendor-doc`

Use `benchmark-run` for executable benchmark evidence only.

Use `vendor-doc` or `operator-run` when recording comparative runtime metadata
that should remain explicitly outside the benchmark result set. Those
observations may be useful for planning, design comparison, or future benchmark
setup, but they are not substitutes for run cards produced by the executable
benchmark harness.

## Execute a split

```bash
./scripts/rae.sh eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split dev \
  --output-dir evals/results/local-dev
```

This emits:

- a benchmark run card
- a benchmark result artifact
- a judge calibration report
- a regression report
- a release gate report
- a unified result ledger
- per-task planned run cards
- checkpoint cards when required

## Route one task spec directly

```bash
./scripts/rae.sh task route \
  --task-spec evals/datasets/tool-selection/tool-selection-core.task-specs.json \
  --task-id tool-selection-dev-orchestration \
  --output evals/results/local-dev/planned-route.json
```

## Evaluate the release gate directly

```bash
./scripts/rae.sh release-gate \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --run-card evals/results/local-dev/run-card-....json \
  --regression-report evals/results/local-dev/regression-....json \
  --ledger evals/results/local-dev/result-ledger.jsonl \
  --output evals/results/local-dev/release-gate-manual.json
```

## Run the frozen production suite

```bash
./evals/harness/run-local.sh suite /tmp/rae-benchmarks
```

## Required checks before publication

- required splits exist
- regression reports pass
- release gate passes
- required claim links resolve
- blocking checkpoints are approved
- run-card provenance fields are present and the result paths resolve under `evals/results/`
- required verification evidence is complete for the run and any residual gaps are named

## Thesis validation

This page operationalizes the research thesis that executable benchmark runs are
only publishable when provenance, calibration, regression status, and release
gates all remain visible.

## Related dossiers

- [CLM-003 benchmark publication metadata](../reference/claims/evidence-index.md#clm-003)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- command success alone is not result validity

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../reference/claims/bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
