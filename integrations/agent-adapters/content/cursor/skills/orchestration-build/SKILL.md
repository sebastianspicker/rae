---
name: orchestration-build
description: "Cursor adapter for /build. Coordinates parallel builder subagents under strict context scoping and verifies plan conformance after implementation."
---

# /build - Coordinated Parallel Implementation (Cursor Adapter)

## Use this when
- Plan (and relevant drift checks) are complete.
- The user requests `/build` or implementation start.

## Model tiers
- Lead: balanced-reasoning coordinator (structured process management)
- Builders: fast worker models (or balanced for `builder_tier: balanced` groups)

## Semantic intent
- Separation of duties: lead coordinates and validates process; builders implement.
- Context minimization: each builder receives only its scoped work package.
- Fresh execution boundaries: each build task runs as its own restartable task session.

## Input
- `.pipeline/runs/<run-id>/plan.json`

## Procedure

### 1. Dispatch scoped work packages
Launch one Task subagent per task group. Each builder receives only:
- its own task set,
- required file excerpts,
- relevant verification commands.
- Start a fresh task session for each planned `execution_session.session_id`; do not inherit failed reasoning from prior tasks.
- Use only the builder assignments declared in `plan.json`; do not add extra workers during build.
- Respect `builder_tier` from each task group in `plan.json` to select the appropriate model tier for that builder.

### 2. Supervise and unblock
Lead tracks progress, resolves blockers, and enforces ownership boundaries. Lead does not author production code.
If a task retries, restart from a fresh session boundary rather than continuing a polluted interaction.

### 3. Collect and verify outputs
After worker completion:
- validate acceptance criteria,
- execute verification commands,
- record deviations.

### 4. Run post-build plan conformance check
Execute `/pmatch` plan-vs-implementation verification.

### 5. Gate evaluation
Require:
- acceptance criteria satisfied,
- verification commands successful,
- no unresolved high-severity drift,
- tests passing.
- `coverage-min` requirement gate for MUST requirements remains satisfied after implementation changes.

Write gate output to:
- `.pipeline/runs/<run-id>/gates/build-gate.json`

## Context isolation requirements
Builders must not see:
- other task groups,
- full design history,
- other builders' intermediate outputs.

## Non-negotiables
- Lead coordinates only
- Ownership map is enforced
- Context leakage between builders is prohibited
- Build retries must follow the planned `execution_session.retry_behavior`
