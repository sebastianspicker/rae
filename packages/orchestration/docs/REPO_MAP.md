# REPO_MAP

## Top-level

- `README.md`
  Package overview, stage model, and quickstart commands.
- `docs/`
  Package-local runbook, repo map, platform notes, and scientific rationale.
- `contracts/`
  Shared JSON schemas for artifacts and quality gates.
- `agent-config/`
  Tool definitions and orchestration constraints.
- `adapters/`
  Generated per-runner orchestration guidance plus the adapter manifest.
- `orchestrators/`
  Stage prompts and orchestration instructions used by the pipeline.
- `scripts/`
  Verification, adapter generation, integrity checks, and pipeline runner code.
- `skills/dev-tools/`
  Deterministic runtime packages used by the orchestration pipeline.

## Runtime skill packages

### `skills/dev-tools/quality-gate`

Validates JSON artifacts against schemas and acceptance criteria.

### `skills/dev-tools/multi-model-review`

Handles finding deduplication, consolidation, and drift-related review tasks.

### `skills/dev-tools/trace-collector`

Validates execution traces and produces deterministic run summaries.

## Cross-cutting flows

- adapter generation and sync:
  `scripts/adapters/generate_adapters.py` and `scripts/check-adapter-sync.sh`
- package verification: `scripts/verify.sh`
- pipeline execution: `scripts/pipeline-init.sh` and `scripts/pipeline/runner.mjs`
- artifact and gate validation: `contracts/` plus `skills/dev-tools/*`
