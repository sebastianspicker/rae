---
name: orchestration-design
description: "Kilo adapter for /design. Produces a first-principles design document from a validated brief with evidence-backed research and repository alignment."
---

# /design - Constraint-Grounded Design (Kilo Adapter)

## Use this when
- `/arm` is complete and `brief.json` passed its gate.
- The user requests `/design`, architecture direction, or approach definition.

## Model tier
Use a balanced-reasoning model. Design follows structured templates with evidence grounding on well-defined brief input.

## Semantic intent
- Evidence-first guidance: design choices must be source-backed.
- Context minimization: only pass brief-derived scope into design reasoning.

## Input
- `.pipeline/runs/<run-id>/brief.json`

## Procedure

### 1. Constraint adjudication
For each constraint in the brief:
- validate interpretation,
- classify hard vs soft,
- flag over-constrained assumptions,
- record rationale.

### 2. Reconstruct approach from verified facts
Build architecture and interfaces from validated requirements and constraints only.

### 3. External grounding
Before recommending libraries/patterns:
- Query live documentation through Context7 MCP.
- Run web search for version-sensitive guidance and pitfalls.
- Record citations with timestamp (`verified_at`).

### 4. Repository fit check
Inspect current code patterns (Read/Grep/Glob) and mark whether each proposal is:
- aligned,
- intentionally divergent,
- net-new.

### 5. Alignment loop with user
Iterate on the design until the user confirms alignment.

### 6. Build artifact
Write `design.json` conforming to `contracts/artifacts/design-document.schema.json`:
- `.pipeline/runs/<run-id>/design.json`

### 7. Gate evaluation
Validate:
- schema compliance,
- no unclassified constraints,
- research entries include `verified_at`,
- user alignment confirmed.

Write gate output to:
- `.pipeline/runs/<run-id>/gates/design-gate.json`

## Required tools
- Context7 MCP (`resolve-library-id`, `get-library-docs`)
- Web search
- Filesystem inspection tools

## Non-negotiables
- Evidence overrides model memory
- Every recommendation must be traceable to a source
- Constraint flags must be explicit, not implied
