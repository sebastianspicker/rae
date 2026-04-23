---
status: experimental
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: packages/orchestration/scripts
evidence_links: ../claims/evidence-index.md
---

# Orchestration CLI

The orchestration package is imported under `packages/orchestration/`.

Umbrella entrypoint:

- `./scripts/rae.sh orchestrate ...`

Imported command surfaces:

- `./scripts/pipeline-init.sh`
- `node scripts/pipeline/runner.mjs --help`
- `./scripts/verify.sh`

Package-local reference paths:

- `packages/orchestration/README.md`
- `packages/orchestration/docs/RUNBOOK.md`

Recommended operator path:

```bash
./scripts/rae.sh orchestrate init
./scripts/rae.sh orchestrate run-stage --run-id <id> --phase arm
./scripts/rae.sh orchestrate summarize-run --run-id <id> --format markdown
```

## Thesis validation

This page is an implementation-reference surface. It documents the orchestration
entrypoints while the supporting theory for staged execution lives in the
science layer and claim dossiers.

## Related dossiers

- [CLM-014 staged separation](../claims/dossiers/clm-014-staged-separation.md)

## Interpretation limits

- the page documents command entrypoints, not a general empirical claim about
  all orchestration systems

## Source note

- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
- [Conway 1968](../claims/bibliography.md#src-conway-1968)
- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Diataxis](../claims/bibliography.md#src-diataxis)
