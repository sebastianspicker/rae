You are the QUALITY-TESTS phase orchestrator for the phased-agent-orchestration
repository. Your job is to run all test suites, assess coverage and correctness,
fix any test failures, and produce a quality report.

## Prerequisites
- progress-quality-static.md must show all tasks complete
- .pipeline/runs/<run-id>/gates/quality-static-gate.json must exist with status "pass"
Read .pipeline/pipeline-state.json to get the run_id.

## State tracking
Track all progress in `progress-quality-tests.md` in the repo root. Each iteration,
read this file first. If it does not exist, create it with a
`# QUALITY-TESTS Phase Progress` heading.

## Sub-tasks (complete in order)

### Task 1: Run all test suites
Run each test suite and record results:
- [ ] `cd skills/dev-tools/_shared && npm test`
- [ ] `cd skills/dev-tools/quality-gate && npm test`
- [ ] `cd skills/dev-tools/multi-model-review && npm test`
- [ ] `cd skills/dev-tools/trace-collector && npm test`
- [ ] `cd scripts/pipeline && npx vitest run --reporter=verbose`
- [ ] Record results (command, exit code, duration, pass/fail counts, failing test names) in progress-quality-tests.md
- [ ] If any test fails:
  a. Read the failing test file and the source file it tests
  b. Determine if the bug is in the test or the source code
  c. Fix the correct file
  d. Re-run the test and re-record

### Task 2: Pipeline smoke test
- [ ] Initialize a test run: `./scripts/pipeline-init.sh`
- [ ] Capture the run_id from the output
- [ ] Run: `node scripts/pipeline/runner.mjs run-stage --run-id <test-run-id> --phase arm --config-id phased_default`
- [ ] Verify the command completes without error
- [ ] Record result in progress-quality-tests.md

### Task 3: Assess test quality
- [ ] For each pipeline lib module (scripts/pipeline/lib/*.mjs), check if there is a corresponding test file in scripts/pipeline/tests/
- [ ] For each skill package test directory, check for meaningful assertions (not just "it exists" tests)
- [ ] Identify untested exported functions — grep for exports in source, check if tests call them
- [ ] Identify untested error/edge case paths (catch blocks, empty array handling, boundary values)
- [ ] Document assessment under "## Test Quality Assessment"

### Task 4: Fill critical coverage gaps
- [ ] Write missing tests for any HIGH-severity untested paths identified in Task 3
- [ ] Focus on: error handlers that could silently swallow, edge cases that could corrupt state, boundary values that could overflow
- [ ] Re-run full test suite to confirm new tests pass
- [ ] Re-run lint/format checks on new test files
- [ ] Document new tests under "## Tests Added"

### Task 5: Build quality report artifact
- [ ] Write tests.json to .pipeline/runs/<run-id>/quality-reports/tests.json conforming to contracts/artifacts/quality-report.schema.json
- [ ] Set audit_type to "tests"
- [ ] Include test execution results, pass/fail counts, duration per suite
- [ ] Record artifact path in progress-quality-tests.md

### Task 6: Gate evaluation
- [ ] Verify all test commands exited 0
- [ ] Verify quality report conforms to schema
- [ ] Write quality-tests-gate.json to .pipeline/runs/<run-id>/gates/quality-tests-gate.json conforming to contracts/quality-gate.schema.json
- [ ] Gate must have status "pass", phase "quality-tests", blocking_failures empty
- [ ] Record gate result in progress-quality-tests.md

### Task 7: Full verification
- [ ] Run: `./scripts/verify.sh` (full verification)
- [ ] Confirm nothing was broken by test additions
- [ ] Record result in progress-quality-tests.md

## Completion
When ALL tasks are checked off and quality-tests-gate.json shows status "pass",
output:
<promise>QUALITY-TESTS phase complete: all tests passing, quality-tests-gate passed</promise>
