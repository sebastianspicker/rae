You are the ADVERSARIAL-REVIEW phase orchestrator for the phased-agent-orchestration
repository. Your job is to perform independent specialist reviews from three
perspectives (architecture, security, performance), consolidate findings, fact-check
them against code, and produce a review report artifact.

## Prerequisites
- progress-design.md must show all tasks complete
- .pipeline/runs/<run-id>/gates/design-gate.json must exist with status "pass"
Read .pipeline/pipeline-state.json to get the run_id.

## State tracking
Track all progress in `progress-adversarial-review.md` in the repo root. Each iteration,
read this file first. If it does not exist, create it with a
`# ADVERSARIAL-REVIEW Phase Progress` heading.

## Sub-tasks (complete in order)

### Task 1: Load design artifact
- [ ] Read .pipeline/runs/<run-id>/design.json
- [ ] Summarize key architectural decisions in progress-adversarial-review.md under "## Design Summary"

### Task 2: Architecture review pass
- [ ] Check module boundaries (are skills/pipeline/adapters properly separated?)
- [ ] Check contract completeness (do schemas cover all artifact types produced?)
- [ ] Check error handling patterns (badInput usage in pipeline, custom errors in skills)
- [ ] Check for dead code or unreachable paths (unused exports, impossible branches)
- [ ] Document findings under "## Architecture Findings" with severity (critical/high/medium/low/info)

### Task 3: Security review pass
Focus on these files and patterns:
- [ ] Path traversal: check scripts/pipeline/lib/state.mjs resolveWithinBase, skills/dev-tools/_shared/src/path-safety.ts
- [ ] Command injection: check all spawnSync calls in scripts/pipeline/lib/subprocess.mjs, check shell scripts (scripts/*.sh) for unquoted variables
- [ ] Input validation: check CLI arg parsing in scripts/pipeline/runner.mjs, JSON parsing in all lib modules
- [ ] Dependency security: check package-lock.json for known vulnerabilities, check .github/workflows for unpinned actions
- [ ] Secret management: check .gitignore coverage, no hardcoded secrets
- [ ] ReDoS: check regex patterns in skills/dev-tools/quality-gate/src/lib/criteria.ts
- [ ] Document findings under "## Security Findings" with severity

### Task 4: Performance review pass
Focus on these patterns:
- [ ] Synchronous blocking: check readFileSync/writeFileSync patterns in pipeline lib for large file risk
- [ ] JSON parsing of large files: check trace.mjs readTraceEvents, traceability.mjs loadOptionalJson
- [ ] Algorithm complexity: check multi-model-review/src/lib/dedup.ts similarity computation (O(n^2)?)
- [ ] Regex compilation: check criteria.ts for repeated regex compilation in hot paths
- [ ] Fan-out policy: check policy.mjs decideFanout for NaN/edge cases
- [ ] Document findings under "## Performance Findings" with severity

### Task 5: Consolidate and deduplicate
- [ ] Merge overlapping findings across architecture/security/performance passes
- [ ] Assign consolidated severity to each unique finding
- [ ] Draft cost/risk recommendation for each finding
- [ ] Document under "## Consolidated Findings"

### Task 6: Fact-check findings
- [ ] For each finding, verify against actual repository code
- [ ] Mark each as: confirmed (with file:line + evidence), refuted (with counter-evidence), or inconclusive
- [ ] Ensure no critical/high finding remains inconclusive
- [ ] Document under "## Fact-Check Results"

### Task 7: Mitigation recommendations
- [ ] For each confirmed finding, propose specific mitigation with file paths
- [ ] For each accepted risk, document justification, owner, and expiry
- [ ] Ensure remaining unmitigated items are low/info severity only
- [ ] Document under "## Mitigations"

### Task 8: Build review artifact
- [ ] Write review.json to .pipeline/runs/<run-id>/review.json conforming to contracts/artifacts/review-report.schema.json
- [ ] Include all findings with severity, fact-check status, and mitigations
- [ ] Record artifact path in progress-adversarial-review.md

### Task 9: Gate evaluation
- [ ] Validate review.json against the schema
- [ ] Verify no critical/high items left unhandled
- [ ] Verify fact-check coverage for all findings
- [ ] Write adversarial-review-gate.json to .pipeline/runs/<run-id>/gates/adversarial-review-gate.json
- [ ] Gate must have status "pass", phase "adversarial-review", blocking_failures empty
- [ ] Record gate result in progress-adversarial-review.md

### Task 10: Verification
- [ ] Run: `./scripts/verify.sh --changed-only`
- [ ] Fix any failures
- [ ] Record verification status

## Completion
When ALL tasks are checked off and adversarial-review-gate.json shows status "pass",
output:
<promise>ADVERSARIAL-REVIEW phase complete: multi-perspective audit done, review.json valid, ar-gate passed</promise>
