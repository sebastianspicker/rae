---
name: orchestration-quality-static
description: "Codex adapter for /quality-static. Enforces lint, format-check, and type-check as a hard quality gate before tests and post-build audits."
---

# /quality-static - Static Quality Gate (Codex Adapter)

## Use this when
- Build gate has passed.
- The user requests static quality checks, linting, formatting checks, or type conformance checks.

## Model tier
Use fast worker models for deterministic command execution and report synthesis.

## Semantic intent
- Separation of duties: static validation runs in an audit context distinct from implementation.
- Evidence-first guidance: gate output records exact command outcomes and remediation hints.

## Input
- Changed implementation files
- `.pipeline/runs/<run-id>/plan.json`

## Procedure

### 1. Execute static checks
Run verification commands in this order:
- lint
- format-check
- typecheck/build

Record command, working directory, exit code, and key output.

### 2. Build quality report
Write quality report artifact (`audit_type: static`) to:
- `.pipeline/runs/<run-id>/quality-reports/static.json`

### 3. Gate evaluation
Require all static commands to pass:
- lint exit code 0,
- format-check exit code 0,
- typecheck/build exit code 0,
- report conforms to `contracts/artifacts/quality-report.schema.json`.

Write gate output to:
- `.pipeline/runs/<run-id>/gates/quality-static-gate.json`

## Non-negotiables
- No auto-fix in gate mode; checks are verification-only.
- Any failed static check blocks progression.
