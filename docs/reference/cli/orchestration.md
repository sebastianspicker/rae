---
status: experimental
owner: orchestration
last_reviewed: 2026-07-24
source_of_truth: packages/orchestration/scripts
evidence_links: ../claims/evidence-index.md
---

# Orchestration CLI

The orchestration package has three command surfaces:

| Surface | Entrypoint | Use |
| --- | --- | --- |
| Autonomous workflow | `./scripts/rae.sh agent ...` | Repository planning, changes, checks, and handoff |
| Stage runner | `./scripts/rae.sh orchestrate ...` | Explicit pipeline state, stages, artifacts, gates, and summaries |
| Worktree lifecycle | `./scripts/rae.sh worktree ...` | Isolated run creation, inspection, resume, and cleanup |

## Autonomous workflow

```bash
./scripts/rae.sh agent doctor
./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --task "Implement the change and verify it"
```

The default run uses `.git/rae-worktrees/<run-id>`. `--through plan` stops
before mutation. `--checkpoint-policy before-mutation-and-ship` pauses before
the first writable stage and before the final release decision.

Run `./scripts/rae.sh agent --help` for run, resume, status, stop, checkpoint,
and event options.

## Stage runner

```bash
./scripts/rae.sh orchestrate init
./scripts/rae.sh orchestrate run-stage --run-id <run-id> --phase arm
./scripts/rae.sh orchestrate summarize-run --run-id <run-id> --format markdown
```

`run-stage` is a low-level artifact and gate interface. Without an input
artifact it produces deterministic fixtures; it does not modify application
code.

The stage order is:

```text
arm
design
adversarial-review
plan
pmatch
build
quality-static
quality-tests
post-build
release-readiness
```

## Worktree lifecycle

```bash
./scripts/rae.sh worktree --help
```

Worktree mode owns the `pipeline/<run-id>` branch, isolated checkout, run
state, and cleanup checks. Cleanup is explicit and refuses uncertain or active
state.

## Package references

- [Package README](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/README.md)
- [Runbook](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/docs/RUNBOOK.md)
- [Platform support](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/docs/PLATFORMS.md)
- [Repository map](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/docs/REPO_MAP.md)

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
