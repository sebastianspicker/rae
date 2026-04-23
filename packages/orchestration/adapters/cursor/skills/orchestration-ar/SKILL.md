---
name: orchestration-ar
description: "Cursor adapter for /ar. Runs independent specialist reviews in parallel, consolidates findings, and emits a fact-check-ready review report."
---

# /ar - Parallel Design Challenge (Cursor Adapter)

## Use this when
- Design artifact exists and passed validation.
- The user requests `/ar`, adversarial review, or multi-angle critique.

## Model tier
- Lead: high-reasoning model for synthesis and adjudication of contradictory findings
- Reviewers: fast worker models in isolated contexts

## Semantic intent
- Parallel challenge: independent reviewers stress-test assumptions.
- Separation of duties: reviewers critique; lead verifies; humans decide mitigations.

## Input
- `.pipeline/runs/<run-id>/design.json`

## Procedure

### 1. Launch independent reviewers (parallel)
Start three Task subagents, each with only design artifact + filesystem + Context7:
- `architect-reviewer`
- `security-engineer`
- `performance-engineer`

Each reviewer returns `Finding[]` entries.

### 2. Consolidate via runtime skill
Send combined reviewer outputs to `multi-model-review` (`action.type = "review"`) for:
- deduplication,
- severity consolidation,
- cost/risk recommendation draft.

### 3. Lead-level fact checking
For each merged finding, verify against repository evidence and mark:
- confirmed,
- refuted,
- inconclusive.

### 4. Human decision pass
Present report with mitigation recommendations and accepted-risk justifications.

### 5. Iterate if needed
Repeat until remaining unresolved items are low-priority and consciously accepted.

### 6. Build artifact
Write `review.json` conforming to `contracts/artifacts/review-report.schema.json`:
- `.pipeline/runs/<run-id>/review.json`
- Include `context_manifest` with loaded files/docs and token estimate.

### 7. Gate evaluation
Validate:
- schema compliance,
- no critical/high items left unhandled,
- fact-check coverage for findings,
- mitigation coverage for significant findings,
- no critical/high finding may remain with `fact_checks.status = inconclusive`,
- every `confirmed`/`refuted` fact-check includes reproducible evidence (file path and reasoning),
- `iteration.remaining_unmitigated` contains only low/info findings.

Write gate output to:
- `.pipeline/runs/<run-id>/gates/adversarial-review-gate.json`

## Non-negotiables
- No reviewer cross-talk
- No dismissal without evidence
- Human approval required before progression
