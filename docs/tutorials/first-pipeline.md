---
status: stable
owner: orchestration
last_reviewed: 2026-07-16
source_of_truth: packages/engine
evidence_links: ../reference/claims/evidence-index.md
---

# First Pipeline

Use this tutorial to learn the low-level artifact and gate API. It suits manual
integrations and deterministic fixtures; use
[First Autonomous Code Change](autonomous-code-change.md) when RAE should invoke
a coding agent and modify a target repository.

## Assumptions

- you are at the repository root
- Node.js 24 or newer and npm are installed
- the engine workspace dependencies are already available via
  `npm ci --ignore-scripts` followed by `npm run build`

## 1. Initialize a run

```bash
npm run rae -- orchestrate init
```

This creates a `.pipeline/` state directory and prints a `run_id`.

The manual pipeline surface does not create a published release. RAE is a
public alpha candidate and interfaces may change.

## 2. Start the first real stage

```bash
npm run rae -- orchestrate run-stage \
  --run-id <run_id> \
  --phase arm \
  --config-id phased_default \
  --taskset examples/minimal-pipeline/taskset.json
```

## 3. Summarize the run

```bash
npm run rae -- orchestrate summarize-run \
  --run-id <run_id> \
  --format markdown
```

## 4. Verify the package

```bash
npm run verify --
```

## What this demonstrates

- staged execution
- explicit run ids
- artifact and gate discipline
- local summary production
- no model or code-writing invocation on this low-level path

## Thesis validation

This is staged execution on a minimal path: initialize a run, execute one phase,
and summarize it. The commands are the local source of truth; the reasoning
behind the structure lives in the linked science and dossier pages.

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
