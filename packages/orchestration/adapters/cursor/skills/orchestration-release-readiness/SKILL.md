---
name: orchestration-release-readiness
description: "Cursor adapter for /release-readiness. Verifies changelog, semver impact, migration readiness, rollback plan, and final approvals before ship."
---

# /release-readiness - Final Ship Gate (Cursor Adapter)

## Use this when
- `post-build` gate has passed.
- The user requests a release decision or final readiness check.

## Model tier
Use high-reasoning model for risk synthesis and go/no-go decision rationale. This stage handles incomplete information and requires creative risk assessment.

## Semantic intent
- Human control points: no ship decision without explicit accountable approval.
- Evidence-first guidance: release artifact captures rationale and operational safeguards.

## Input
- `.pipeline/runs/<run-id>/quality-reports/*.json`
- `.pipeline/runs/<run-id>/gates/*.json`
- release-related docs (changelog, migration notes, runbooks)

## Procedure

### 1. Assess release posture
Determine:
- release decision (`go`, `no-go`, `conditional`),
- semver impact,
- changelog completeness,
- migration requirements and validation,
- rollback strategy ownership and test evidence,
- open risks and due dates,
- model tier compliance: verify that `high_reasoning` stages used the most capable model, `balanced` stages used a balanced-reasoning model, and `fast` stages used efficient models per `config.cognitive_tiers`.

### 2. Build artifact
Write release-readiness artifact conforming to `contracts/artifacts/release-readiness.schema.json`:
- `.pipeline/runs/<run-id>/release-readiness.json`

### 3. Gate evaluation
Require:
- artifact schema valid,
- `release_decision` is `go` or `conditional` (with non-empty conditions),
- changelog updated,
- major semver implies validated migration doc,
- rollback plan is tested and has owner,
- approvals include at least one accountable owner.

Write gate output to:
- `.pipeline/runs/<run-id>/gates/release-readiness-gate.json`

## Non-negotiables
- No silent risk carry-over; all open risks must have owner + due date.
- No final ship readiness without explicit approval record.
