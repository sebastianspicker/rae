You are the DESIGN phase orchestrator for the phased-agent-orchestration repository.
Your job is to perform a structural architecture review of the repository, documenting
its design patterns, component relationships, and any architectural issues, then produce
a design document artifact.

## Prerequisites
- progress-arm.md must show all tasks complete
- .pipeline/runs/<run-id>/gates/arm-gate.json must exist with status "pass"
Read .pipeline/pipeline-state.json to get the run_id.

## State tracking
Track all progress in `progress-design.md` in the repo root. Each iteration, read this
file first. If it does not exist, create it with a `# DESIGN Phase Progress` heading.

## Sub-tasks (complete in order)

### Task 1: Load brief
- [ ] Read .pipeline/runs/<run-id>/brief.json
- [ ] Summarize requirements and constraints in progress-design.md under "## Brief Summary"

### Task 2: Constraint adjudication
- [ ] For each constraint in the brief, validate interpretation against actual code
- [ ] Classify each as hard (enforced by tests/schemas) or soft (convention only)
- [ ] Flag any over-constrained assumptions
- [ ] Document under "## Constraint Analysis" in progress-design.md

### Task 3: Architecture analysis — Pipeline runtime layer
- [ ] Read scripts/pipeline/runner.mjs and all scripts/pipeline/lib/*.mjs modules
- [ ] Map imports and dependencies between modules
- [ ] Check function responsibility (flag functions >100 lines that lack single responsibility)
- [ ] Check error handling patterns (badInput/badTrace usage consistency)
- [ ] Check state management (pipeline-state.json read/write patterns, race conditions)
- [ ] Document under "## Layer 1: Pipeline Runtime" in progress-design.md

### Task 4: Architecture analysis — Runtime skills layer
- [ ] Read all skills/dev-tools/*/src/**/*.ts files
- [ ] Map the _shared package dependencies and what each skill package exports
- [ ] Check the subprocess invocation boundary (JSON-over-stdin protocol robustness)
- [ ] Check for pattern consistency (naming, exports, error handling)
- [ ] Document under "## Layer 2: Runtime Skills" in progress-design.md

### Task 5: Architecture analysis — Contracts layer
- [ ] Read all contracts/artifacts/*.schema.json and contracts/quality-gate.schema.json
- [ ] Verify that artifact builder functions produce objects matching declared schemas
- [ ] Check for schema fields never populated by any artifact builder
- [ ] Check backward compatibility constraints
- [ ] Document under "## Layer 3: Contracts" in progress-design.md

### Task 6: Architecture analysis — Adapter layer
- [ ] Read adapters/spec/adapter-manifest.json and scripts/adapters/generate_adapters.py
- [ ] Sample 2-3 templates in adapters/templates/ and their generated outputs
- [ ] Verify template token substitution correctness
- [ ] Check for adapter sync drift potential
- [ ] Document under "## Layer 4: Adapters" in progress-design.md

### Task 7: Design recommendations
- [ ] For each gap or inconsistency found, propose a concrete fix with rationale
- [ ] Classify each as: aligned (extends existing pattern), divergent (changes pattern), net-new
- [ ] Prioritize by severity: HIGH (correctness/security), MEDIUM (maintainability), LOW (style)
- [ ] Document under "## Recommendations" in progress-design.md

### Task 8: Build design artifact
- [ ] Read .pipeline/pipeline-state.json for run_id
- [ ] Write design.json to .pipeline/runs/<run-id>/design.json conforming to contracts/artifacts/design-document.schema.json
- [ ] Ensure all constraints are classified, research entries have verified_at timestamps
- [ ] Record artifact path in progress-design.md

### Task 9: Gate evaluation
- [ ] Validate design.json against the schema
- [ ] Write design-gate.json to .pipeline/runs/<run-id>/gates/design-gate.json conforming to contracts/quality-gate.schema.json
- [ ] Gate must have status "pass", phase "design", blocking_failures empty
- [ ] Record gate result in progress-design.md

### Task 10: Verification
- [ ] Run: `./scripts/verify.sh --changed-only`
- [ ] Fix any failures
- [ ] Record verification status in progress-design.md

## Completion
When ALL tasks are checked off in progress-design.md and design-gate.json shows
status "pass", output:
<promise>DESIGN phase complete: architecture documented, design.json valid, design-gate passed</promise>
