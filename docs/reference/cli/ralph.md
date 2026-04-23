---
status: experimental
owner: loops
last_reviewed: 2026-04-12
source_of_truth: packages/loops/ralph/scripts
evidence_links: ../claims/evidence-index.md
---

# Ralph CLI

The Ralph loop package is imported under `packages/loops/ralph/`.

Umbrella entrypoints:

- `./scripts/rae.sh ralph ...`
- `./scripts/rae.sh workflow repo-audit ...`

Imported command surfaces:

- `./ralph.sh`
- `./scripts/run_tests.sh`
- `./scripts/bootstrap_embedded.sh`

Package-local reference paths:

- `packages/loops/ralph/README.md`
- `packages/loops/ralph/INSTRUCTIONS.md`

Recommended operator path:

```bash
./scripts/rae.sh ralph --check
./scripts/rae.sh workflow repo-audit bootstrap /tmp/demo-repo
```

## Thesis validation

This page documents the Ralph entrypoints while the broader claim it serves is
that bounded deterministic control surfaces are easier to audit and reproduce.

## Related dossiers

- [CLM-010 reproducibility layers](../claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- command availability does not by itself prove loop reliability under all task
  distributions

## Source note

- [Amdahl 1967](../claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Diataxis](../claims/bibliography.md#src-diataxis)
