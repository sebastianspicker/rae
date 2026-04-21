---
name: orchestration-pipeline
description: "Cursor adapter orchestrator for the full phased workflow. Advances stages only on passing gates and explicit human checkpoints."
---

# Orchestration Pipeline (Cursor Adapter)

## Use this when
- User asks to run/resume/check the full orchestration flow.

## Prerequisites
- `.pipeline/` run-state directory
- `contracts/artifacts/*.schema.json`
- `contracts/quality-gate.schema.json`
- `adapters/cursor/skills/orchestration-pipeline/SKILL.md`

## Semantic intent
- Human control points: critical transitions require explicit approvals.
- Capability allocation: use tiered model assignment by stage responsibility.
- Context minimization: transfer only required artifacts between stages.
- Policy-driven parallelism: choose reviewer/builder fan-out via `config.orchestration_policy`.

## Stage order

```
arm -> design -> adversarial-review -> plan -> pmatch -> build -> quality-static -> quality-tests -> post-build -> release-readiness
```

## Procedure

### 1. Initialize or resume run state
- If missing, create run directory and `pipeline-state.json`.
- If present, load current phase and completed gates.

### 2. Execute stage-by-stage
For each stage:
1. Read required predecessor artifact(s)
2. Invoke matching stage adapter skill:
   - `arm` -> `orchestration-arm`
   - `design` -> `orchestration-design`
   - `adversarial-review` -> `orchestration-ar`
   - `plan` -> `orchestration-plan`
   - `pmatch` -> `orchestration-pmatch`
   - `build` -> `orchestration-build`
   - `quality-static` -> `orchestration-quality-static`
   - `quality-tests` -> `orchestration-quality-tests`
   - `post-build` -> `orchestration-postbuild`
   - `release-readiness` -> `orchestration-release-readiness`
3. Validate output using quality-gate and schema contracts
   - enforce `context_manifest` budget checks (`count-max`, `number-max`) when enabled
4. Persist gate result under `.pipeline/runs/<run-id>/gates/`
5. Advance state only when gate passes
6. Stop immediately on gate failure and report blockers

### 3. Enforce human checkpoints
Do not auto-advance without explicit user approval at:
- `arm` closure
- `design` alignment
- `adversarial-review` acceptance
- `release-readiness` decision when `release_decision` is `conditional` or `no-go`

### 4. Post-build processing
After `quality-tests` gate pass:
- run denoise,
- run frontend/backend/docs/security audits (parallel when independent),
- for security audit, execute fix + rescan loop until no open critical/high findings remain and all mandatory security categories are covered,
- aggregate quality reports.

### 5. Release readiness gate
After post-build gate pass:
- evaluate semver impact, changelog, migration needs, rollback readiness, and explicit approvals,
- block closure unless release-readiness gate passes.

### 6. Persist state transitions
Update `.pipeline/pipeline-state.json` after each stage transition.

### 7. Trace and evaluation artifacts
- Append execution events to `.pipeline/runs/<run-id>/trace.jsonl`.
- Run `trace-collector` to generate `.pipeline/runs/<run-id>/trace.summary.json`.
- When requested, aggregate matrix evaluations to `.pipeline/evaluations/<eval-id>/evaluation-report.json`.

### 8. Security exception handling
Any accepted security risk must be explicit and include:
- owner,
- justification,
- expiry date,
- planned follow-up.
Do not close pipeline if these fields are missing.

Security risk acceptance is only allowed after:
- at least one remediation attempt for the finding,
- documented residual risk,
- explicit human sign-off.

## Context-transfer rule
Each stage receives only the artifacts it needs. Do not transfer full conversational history across stages.

## Cognitive tier mapping
The pipeline state `config.cognitive_tiers` assigns abstract tiers to stages. Adapters should map these to runner-specific models:

| Tier | Stage roles | Characteristics |
|------|------------|-----------------|
| `high_reasoning` | arm, ar-lead, release-readiness | Ambiguous input, synthesis, risk decisions |
| `balanced` | design, plan, build-lead, pmatch-adjudicator | Structured reasoning on well-defined inputs |
| `fast` | ar-reviewers, pmatch-extractors, build-workers, quality-static, quality-tests, post-build | Narrow scope, deterministic, template-following |

Runners should document their tier-to-model mapping (e.g., Claude: Opus for `high_reasoning`, Sonnet for `balanced`, Haiku for `fast`).
Prefer capability tiers in pipeline config; keep model-specific names as adapter-level mapping only.
