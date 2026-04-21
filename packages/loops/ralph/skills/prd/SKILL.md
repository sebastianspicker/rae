---
name: prd
description: "Create a detailed feature PRD in Markdown as input for the Ralph PRD conversion."
user-invocable: true
---

# PRD Generator (Ralph Audit Template)

Creates a precise feature PRD in Markdown. This document serves as input for the `skills/ralph` converter to `prd.json`.

## Goal

1. Capture the feature idea.
2. Ask 3-5 critical clarifying questions with answer options.
3. Write the PRD in a clear, actionable structure.
4. Save the file under `tasks/prd-<feature>.md`.

No implementation in this step.

## Clarifying Questions (Required When Unclear)

Focus on:
- Problem/Outcome
- Target users
- Scope/Non-Goals
- Constraints/Risks
- Success criteria

Use numbered questions with answer options (`A/B/C/D`) for quick responses.

## Output Format PRD (Markdown)

1. `# PRD: <Feature>`
2. `## Context / Problem`
3. `## Goals`
4. `## User Stories`
5. `## Functional Requirements`
6. `## Non-Goals (Out of Scope)`
7. `## Technical Constraints`
8. `## Acceptance Criteria / Success Metrics`
9. `## Open Questions`

## Story Quality Rules

Each story must:
- be small enough for a focused iteration,
- contain verifiable acceptance criteria,
- have clear boundaries (`out of scope`),
- name concrete evidence sources (files/checks/outputs).

If UI is involved, require explicit browser verification as a criterion.

## Saving

- Folder: `tasks/`
- Filename: `prd-<feature-kebab-case>.md`

## Checklist

- [ ] Clarifying questions asked and answered
- [ ] Stories small and unambiguous
- [ ] Acceptance criteria testable
- [ ] Out-of-scope clearly named
- [ ] File saved in `tasks/`
