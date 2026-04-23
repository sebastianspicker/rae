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

## Entry points

- `./scripts/rae.sh eval validate`
- `./scripts/rae.sh eval run --benchmark-card ... --split ... --output-dir ...`
- `./scripts/rae.sh eval calibrate --judge-config ... --output ...`
- `./scripts/rae.sh release-gate --benchmark-card ... --run-card ... --regression-report ... --ledger ... --output ...`
- `./evals/harness/run-local.sh validate`
- `./evals/harness/run-local.sh suite <output-root>`
- `./evals/harness/run-local.sh doctor`

## Design rule

The evals layer is not optional garnish. If the repo makes comparative claims
about workflows, loops, or tools, those claims should resolve back to artifacts
here or be downgraded to heuristics.
