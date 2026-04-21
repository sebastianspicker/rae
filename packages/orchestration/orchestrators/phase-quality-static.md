You are the QUALITY-STATIC phase orchestrator for the phased-agent-orchestration
repository. Your job is to enforce static quality checks (lint, format, typecheck)
as a hard gate, fixing any violations found.

## Prerequisites
- progress-build.md must show all tasks complete
- .pipeline/runs/<run-id>/gates/build-gate.json must exist with status "pass"
Read .pipeline/pipeline-state.json to get the run_id.

## State tracking
Track all progress in `progress-quality-static.md` in the repo root. Each iteration,
read this file first. If it does not exist, create it with a
`# QUALITY-STATIC Phase Progress` heading.

## Sub-tasks (complete in order)

### Task 1: Run lint checks
Run lint for each workspace package and record results:
- [ ] `cd skills/dev-tools/_shared && npm run lint`
- [ ] `cd skills/dev-tools/quality-gate && npm run lint`
- [ ] `cd skills/dev-tools/multi-model-review && npm run lint`
- [ ] `cd skills/dev-tools/trace-collector && npm run lint`
- [ ] Record results (command, exit code, errors) in progress-quality-static.md
- [ ] If any failures: fix lint violations in the source files, re-run and re-record

### Task 2: Run format checks
Run format check for each workspace package:
- [ ] `cd skills/dev-tools/_shared && npm run format:check`
- [ ] `cd skills/dev-tools/quality-gate && npm run format:check`
- [ ] `cd skills/dev-tools/multi-model-review && npm run format:check`
- [ ] `cd skills/dev-tools/trace-collector && npm run format:check`
- [ ] Record results in progress-quality-static.md
- [ ] If any failures: fix formatting violations, re-run and re-record

### Task 3: Run typecheck/build
Build each workspace package (build includes typecheck):
- [ ] `cd skills/dev-tools/_shared && npm run build`
- [ ] `cd skills/dev-tools/quality-gate && npm run build`
- [ ] `cd skills/dev-tools/multi-model-review && npm run build`
- [ ] `cd skills/dev-tools/trace-collector && npm run build`
- [ ] Record results in progress-quality-static.md
- [ ] If any failures: fix type errors, re-run and re-record

### Task 4: Run orchestration integrity checks
- [ ] `python3 scripts/adapters/generate_adapters.py --check` (adapter sync)
- [ ] `./scripts/check-orchestration-integrity.sh` (manifest integrity)
- [ ] `python3 scripts/check-markdown-links.py --root .` (doc links)
- [ ] `./scripts/check-repo-hygiene.sh` (repo hygiene)
- [ ] Record results in progress-quality-static.md
- [ ] If any failures: fix and re-run

### Task 5: Build quality report artifact
- [ ] Write static.json to .pipeline/runs/<run-id>/quality-reports/static.json conforming to contracts/artifacts/quality-report.schema.json
- [ ] Set audit_type to "static"
- [ ] Include all check results with command, exit_code, violations (if any)
- [ ] Record artifact path in progress-quality-static.md

### Task 6: Gate evaluation
- [ ] Verify all static checks passed (exit code 0 for each command)
- [ ] Verify quality report conforms to schema
- [ ] Write quality-static-gate.json to .pipeline/runs/<run-id>/gates/quality-static-gate.json conforming to contracts/quality-gate.schema.json
- [ ] Gate must have status "pass", phase "quality-static", blocking_failures empty
- [ ] Record gate result in progress-quality-static.md

## Completion
When ALL tasks are checked off and quality-static-gate.json shows status "pass",
output:
<promise>QUALITY-STATIC phase complete: lint+format+typecheck all pass, quality-static-gate passed</promise>
