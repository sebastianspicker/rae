---
status: stable
owner: orchestration
last_reviewed: 2026-04-12
source_of_truth: packages/orchestration
evidence_links: ../reference/claims/evidence-index.md
---

# First Pipeline

This tutorial walks through the minimum local orchestration path.

## Assumptions

- you are at the repository root
- `node`, `npm`, and `python3` are installed
- the orchestration package dependencies are already available via
  `./scripts/verify.sh` or local install

## 1. Initialize a run

```bash
./scripts/rae.sh orchestrate init
```

This creates a `.pipeline/` state directory and prints a `run_id`.

## 2. Start the first real stage

```bash
./scripts/rae.sh orchestrate run-stage \
  --run-id <run_id> \
  --phase arm \
  --config-id phased_default \
  --taskset examples/minimal-pipeline/taskset.json
```

## 3. Summarize the run

```bash
./scripts/rae.sh orchestrate summarize-run \
  --run-id <run_id> \
  --format markdown
```

## 4. Verify the package

```bash
./scripts/verify.sh
```

## What this demonstrates

- staged execution
- explicit run ids
- artifact and gate discipline
- local summary generation

## Thesis validation

This tutorial demonstrates the staged-execution thesis on a minimal path. The
commands are local truth; the scientific support for why this structure exists
lives in the linked science and dossier surfaces.

## Related dossiers

- [CLM-014 staged separation](../reference/claims/dossiers/clm-014-staged-separation.md)

## Interpretation limits

- one successful tutorial run is only an operator familiarization surface, not a
  benchmark result

## Source note

- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Conway 1968](../reference/claims/bibliography.md#src-conway-1968)
- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
