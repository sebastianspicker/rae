You are the POST-BUILD phase orchestrator for the phased-agent-orchestration repository.
Your job is to run cleanup (denoise), then perform audits (documentation freshness,
security, code quality), fix any findings, and aggregate results.

## Prerequisites
- progress-quality-tests.md must show all tasks complete
- .pipeline/runs/<run-id>/gates/quality-tests-gate.json must exist with status "pass"
Read .pipeline/pipeline-state.json to get the run_id.

## State tracking
Track all progress in `progress-post-build.md` in the repo root. Each iteration,
read this file first. If it does not exist, create it with a
`# POST-BUILD Phase Progress` heading.

## Sub-tasks (complete in order)

### Task 1: Denoise pass
- [ ] Scan all source files (scripts/pipeline/lib/*.mjs, skills/dev-tools/*/src/**/*.ts) for:
  - Dead imports (imported but never referenced)
  - Unused variables (declared but never read)
  - Debug leftovers (console.log, debugger statements, commented-out code blocks)
- [ ] Remove any found while preserving behavior
- [ ] Re-run tests to confirm no regressions: `./scripts/verify.sh --changed-only`
- [ ] Write denoise.json to .pipeline/runs/<run-id>/quality-reports/denoise.json conforming to contracts/artifacts/quality-report.schema.json with audit_type "denoise"
- [ ] Document changes under "## Denoise Results" in progress-post-build.md

### Task 2: Documentation freshness audit
- [ ] Check README.md accuracy: does it match current repo structure and features?
- [ ] Check AGENTS.md completeness: all packages, all verification commands, all rules
- [ ] Check docs/*.md for stale references:
  - Dead internal links (files that were renamed/moved)
  - Outdated paths or command syntax
  - Wrong version numbers or dates
- [ ] Run: `python3 scripts/check-markdown-links.py --root .`
- [ ] Fix any stale references found
- [ ] Write docs.json to .pipeline/runs/<run-id>/quality-reports/docs.json conforming to contracts/artifacts/quality-report.schema.json with audit_type "docs"
- [ ] Document under "## Documentation Audit"

### Task 3: Security review
- [ ] Run `npm audit` for dependency vulnerabilities
- [ ] Check path handling for traversal safety (resolveWithinBase in state.mjs, path-safety.ts)
- [ ] Check subprocess spawns for injection safety (no shell:true, array args used)
- [ ] Check .gitignore covers sensitive file patterns (.env, credentials, keys)
- [ ] Check no hardcoded secrets in any tracked file
- [ ] For any critical/high findings: fix and re-scan (fix loop)
- [ ] Write security.json to .pipeline/runs/<run-id>/quality-reports/security.json conforming to contracts/artifacts/quality-report.schema.json with audit_type "security"
- [ ] Security report must include: category coverage list, fix-loop evidence (before/after counts)
- [ ] All security findings must be "fixed" or "accepted-risk" (with owner + expiry)
- [ ] Document under "## Security Audit"

### Task 4: Code quality audit
- [ ] Check error handling consistency: pipeline modules use badInput(), eval scripts use Error()
- [ ] Check naming conventions: camelCase in JS/TS, kebab-case in filenames, snake_case in JSON schema keys
- [ ] Check for remaining TODO/FIXME/HACK comments — resolve or document as known-issue
- [ ] Check for any commented-out code blocks — remove or document why kept
- [ ] Write backend.json to .pipeline/runs/<run-id>/quality-reports/backend.json conforming to contracts/artifacts/quality-report.schema.json with audit_type "backend"
- [ ] Document under "## Code Quality Audit"

### Task 5: Aggregate results
- [ ] List all audit report summaries: denoise, docs, security, backend
- [ ] Count critical/high violations across all reports
- [ ] Verify: no critical violations overall, no high security violations
- [ ] Verify: tests still pass after all cleanup: `./scripts/verify.sh`
- [ ] Document under "## Aggregated Results"

### Task 6: Gate evaluation
- [ ] Write postbuild-gate.json to .pipeline/runs/<run-id>/gates/postbuild-gate.json conforming to contracts/quality-gate.schema.json
- [ ] Gate status "pass" requires:
  - No critical violations overall
  - No high security violations
  - Tests still green after cleanup
  - All security findings are "fixed" or "accepted-risk" with owner+expiry
- [ ] Record gate result in progress-post-build.md

## Completion
When ALL tasks are checked off and postbuild-gate.json shows status "pass", output:
<promise>POST-BUILD phase complete: cleanup done, audits passed, postbuild-gate passed</promise>
