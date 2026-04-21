---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: scripts/rae.sh
evidence_links: ../claims/evidence-index.md
---

# Umbrella CLI

The umbrella operator entrypoint is:

- `./scripts/rae.sh`

It is the top-level harness for this repository. It does not replace the
imported runtimes. It dispatches to them with one stable surface and keeps the
umbrella-level workflows explicit.

## Command families

- `./scripts/rae.sh verify`
  Run repository verification.
- `./scripts/rae.sh doctor`
  Check local prerequisites and imported entrypoints.
- `./scripts/rae.sh task route ...`
  Route one task spec to the smallest adequate runtime and emit a planned run
  card.
- `./scripts/rae.sh checkpoint ...`
  Create or resolve explicit human checkpoint cards.
- `./scripts/rae.sh orchestrate ...`
  Dispatch to `packages/orchestration/`. This is the complete orchestration
  command surface.
- `./scripts/rae.sh worktree ...`
  Use orchestration's worktree-backed lifecycle through a thinner umbrella alias.
- `./scripts/rae.sh ralph ...`
  Dispatch to `packages/loops/ralph/`.
- `./scripts/rae.sh hygiene coauthor-cleaner ...`
  Dispatch to `tools/repo-hygiene/coauthor-trailer-cleaner/`.
- `./scripts/rae.sh eval validate`
  Validate benchmark and run-card metadata.
- `./scripts/rae.sh eval run ...`
  Execute one benchmark split and emit result artifacts.
- `./scripts/rae.sh eval calibrate ...`
  Calibrate the current judge.
- `./scripts/rae.sh release-gate ...`
  Enforce release-blocking regression and evidence gates.
- `./scripts/rae.sh workflow ...`
  Use scenario-oriented aliases for the imported runtimes.

## Workflow aliases

- `workflow repo-audit`
  Use Ralph as the deterministic audit and scoped-fix engine. This alias keeps
  the common audit actions short while `./scripts/rae.sh ralph ...` remains the
  full runtime surface.
- `workflow long-horizon`
  Use phased orchestration for explicit stage/gate pipelines. This alias maps
  to the same orchestration runtime and exposes the common stage, artifact,
  review-state, and progress-summary actions.
- `workflow hygiene`
  Use the narrow repo-hygiene tool lane.

## Doctor semantics

`./scripts/rae.sh doctor` treats the umbrella execution stack as required and
reports secondary tooling separately. Optional commands such as `mkdocs` or
`git-filter-repo` are reported as warnings when absent instead of failing the
core runtime check.

## Design rule

The umbrella CLI is intentionally thin. Reliability comes from:

- keeping umbrella memory in `AGENTS.md`
- preserving package-local source-of-truth behavior
- exposing one stable operator path
- making eval and verification entrypoints as easy to reach as the runtimes

Worktree mode follows the same rule: the umbrella exposes worktree lifecycle
aliases, but the orchestration package remains the source of truth for worktree
state, branches, traces, and cleanup behavior.

Do not add umbrella-only behavior that silently diverges from the imported
packages.

## Thesis validation

This page is an implementation-reference surface. Its command truth lives in
`scripts/rae.sh`, while its broader rationale is that one thin operator entry
reduces routing ambiguity without erasing package-local ownership.

## Related dossiers

- [CLM-011 runtime-selection signals](../claims/evidence-index.md#clm-011)
- [CLM-017 documentation reliability](../claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- a thin umbrella CLI improves discoverability, not universal workflow quality

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
