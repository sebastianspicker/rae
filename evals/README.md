# Evals

This directory is the umbrella’s measurement layer.

## Current contents

- benchmark cards
- frozen datasets
- golden expectations
- family rubrics
- run cards
- scenario families
- result artifacts
- schemas for metadata validation
- harness scripts for metadata validation and local inventory checks
- executable benchmark runners
- judge calibration reports
- regression reports
- release gate reports
- unified result ledger artifacts
- experimental autonomous code-change fixtures and outcome reports
- strict outcome-report and paired-comparison evidence schemas
- bounded offline policy-campaign lineage

## Entry points

- `./scripts/rae.sh eval validate`
- `./scripts/rae.sh eval run --benchmark-card ... --split ... --output-dir ...`
- `./scripts/rae.sh eval calibrate --judge-config ... --output ...`
- `./scripts/rae.sh eval outcome --task-bundle ... --fixture-root ... --policy ... --split ... --output-dir ... --acknowledge-provider-usage`
- `./scripts/rae.sh eval compare-outcomes --baseline ... --challenger ... --output ...`
- `./scripts/rae.sh eval optimize --campaign ... --baseline-evaluation ... --candidate-policy ... --candidate-evaluation ... --sealed-evaluation ... --output-dir ...`
- `./scripts/rae.sh release-gate --benchmark-card ... --run-card ... --regression-report ... --ledger ... --output ...`
- `./evals/harness/run-local.sh validate`
- `./evals/harness/run-local.sh suite <output-root>`
- `./evals/harness/run-local.sh doctor`

## Run artifact flow

One benchmark split follows this path:

1. Load a benchmark card from `evals/benchmarks/`.
2. Load task specs from `evals/datasets/`.
3. Route each task to the smallest adequate runtime.
4. Execute the runtime command in a local workspace.
5. Write command results, traces, checkpoints, and run cards under
   `evals/results/`.
6. Compare the run against baseline and release-gate policy.

The runner is deliberately local and deterministic. It records shell command
transcripts and produced artifacts; it does not turn benchmark success into a
documentation claim unless the claim layer links back to that evidence.

## Design rule

The evals layer is not optional garnish. If the repo makes comparative claims
about workflows, loops, or tools, those claims should resolve back to artifacts
here or be downgraded to heuristics.

The autonomous outcome and policy-optimizer lanes are experimental. Outcome
runs use a fixed RAE entrypoint and closed judge registry, keep provider usage
behind explicit acknowledgement, cap a matrix at three repeats, eight tasks,
and twelve provider calls, and treat missing resource measurements as failures.
Candidate code is verified only under an evaluator-owned OS sandbox;
an unavailable or rejected sandbox records `evaluator_safety_failure` and never
falls back to direct execution. A timed-out provider process group is a hard
failure and records uncertain containment because POSIX cannot prove teardown
of a deliberately detached session. The optimizer consumes precomputed evidence,
hashes evaluator code, schemas, task bundles, and fixtures, recomputes report
aggregates and pairs raw challenger reports against the actual incumbent,
requires an exact evaluator manifest, retains every decision, requires identical
development task matrices plus a distinct held-out task-matrix digest, and
cannot promote a policy automatically.
