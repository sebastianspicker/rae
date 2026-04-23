---
name: ralph
description: "Convert a Markdown PRD to the Ralph Audit `prd.json` schema (audit/linting/fixing Stories)."
user-invocable: true
---

# PRD -> Ralph JSON Converter

Converts a PRD (Markdown) into this template schema:
- `defaults` block (complete, schema-conformant),
- `stories[]` with `mode`, `scope`, `acceptance_criteria`, `steps`, `verification`, `out_of_scope`,
- `passes: false` for all stories.

## Target Schema (Required Fields)

Top-Level:
- `schema_version`
- `project`
- `defaults`
- `stories`

`defaults`:
- `mode_default`
- `max_stories_default`
- `model_default`
- `reasoning_effort_default`
- `report_dir`
- `sandbox_by_mode`
- `lint_detection_order`

Story:
- `id`, `title`, `priority`, `mode`, `scope`, `acceptance_criteria`, `passes`
- optional: `notes`, `objective`, `steps`, `verification`, `out_of_scope`

## Conversion Rules

1. Generate small, iterative stories with a clear sequence.
2. Typically group into:
  - `audit` (analysis, read-only),
  - `linting` (checks, read-only),
  - `fixing` (targeted corrections, write).
3. Each story needs exactly one AC line with:
  - `Created <repo-rel-path>.md ...`
4. `scope` must be restrictive and realistic.
5. Keep `steps` small (prefer many small steps over few large ones).
6. Formulate `verification` as an explicit checklist.
7. Set `out_of_scope` for scope containment.

## Deterministic Prioritization

- Priorities strictly ascending.
- Dependencies first.
- No story may depend on later stories.

## Output

- Target: `prd.json` in the Ralph template folder.
- Then ensure schema/runtime validation:
  - `./tests/ralph_validation_test.sh`
  - `./tests/ralph_schema_runtime_contract_test.sh`

## Checklist

- [ ] All required fields present
- [ ] Exactly one `Created ...` line per story
- [ ] All stories with `passes: false`
- [ ] `mode` only `audit|linting|fixing`
- [ ] Priorities unique and ordered
- [ ] Scope/Verification/Out-of-Scope clear
