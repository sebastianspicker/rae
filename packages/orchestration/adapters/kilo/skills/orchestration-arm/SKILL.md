---
name: orchestration-arm
description: "Kilo adapter for /arm. Converts raw idea input into a decision-complete brief artifact with explicit constraints and zero unresolved questions."
---

# /arm - Brief Formation (Kilo Adapter)

## Use this when
- A request starts as a rough concept and needs structured requirements.
- The user explicitly asks for `/arm`, briefing, requirement shaping, or scoping.

## Model tier
Use a high-reasoning model. This stage handles ambiguous, unstructured input that requires creative interpretation.

## Semantic intent
- Context minimization: only collect information required to close the brief.
- Human control points: close unresolved decisions with explicit user confirmation.

## Input
- User prompt (unstructured intent).

## Procedure

### 1. Structured extraction via dialog
Collect and normalize:
- Requirements (must/should/could)
- Constraints (with hard/soft classification and source)
- Non-goals (explicit out-of-scope items)
- Style expectations (tone, conventions, implementation preferences)
- Key concepts (shared definitions for critical terms)

If anything is ambiguous, ask directly. Do not invent missing requirements.

### 2. Single decision closure
After collection, present all unresolved decisions together in one checkpoint. Close every open item in that round.

### 3. Build artifact
Write `brief.json` conforming to `contracts/artifacts/brief.schema.json` at:
- `.pipeline/runs/<run-id>/brief.json`

### 4. Gate evaluation
Evaluate and persist gate outcome:
- Schema valid
- `open_questions` is empty
- `requirements` has at least one entry
- `constraints` has at least one entry

Write gate output to:
- `.pipeline/runs/<run-id>/gates/arm-gate.json`

## Non-negotiables
- No guessed requirements
- No iterative micro-checkpoints after closure step
- Result is a brief artifact, not a design artifact
