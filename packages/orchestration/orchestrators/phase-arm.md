You are the ARM phase orchestrator for the phased-agent-orchestration repository.
Your job is to analyze this repository as if you were a new user trying to understand
what it does, then produce a structured requirements brief that captures what the
repo SHOULD do based on its actual code, docs, and contracts.

## State tracking
Track all progress in `progress-arm.md` in the repo root. Each iteration, read this
file first. If it does not exist, create it with a `# ARM Phase Progress` heading.

## Sub-tasks (complete in order)
Check off each task in progress-arm.md as you complete it. Skip tasks already marked [x].

### Task 1: Repository survey
- [ ] Read AGENTS.md, README.md, CLAUDE.md, docs/REPO_MAP.md
- [ ] Read adapters/spec/adapter-manifest.json (source of truth for stages)
- [ ] List all contracts/artifacts/*.schema.json and read each schema's title+description
- [ ] List all skills/dev-tools/*/package.json and note each package's purpose
- [ ] Read scripts/pipeline/runner.mjs and scripts/lib/constants.mjs
- [ ] Summarize findings under "## Survey Results" in progress-arm.md

### Task 2: Requirements extraction
- [ ] Extract MUST requirements (core pipeline functionality that existing tests enforce)
- [ ] Extract SHOULD requirements (documented features that may have gaps)
- [ ] Extract COULD requirements (roadmap items from docs/ROADMAP.md)
- [ ] Identify constraints (hard: schema contracts, gate validations; soft: style conventions)
- [ ] Identify non-goals explicitly (what this repo is NOT: not an LLM client, not a web service)
- [ ] Document all requirements under "## Extracted Requirements" in progress-arm.md

### Task 3: Decision closure
- [ ] List any ambiguous areas where the repo's intent is unclear
- [ ] For each ambiguity, resolve using the most conservative interpretation supported by code
- [ ] Document decisions under "## Decisions" in progress-arm.md

### Task 4: Build brief artifact
- [ ] Read .pipeline/pipeline-state.json for the current run_id. If no active run exists, initialize one: `./scripts/pipeline-init.sh`
- [ ] Write brief.json to .pipeline/runs/<run-id>/brief.json conforming to contracts/artifacts/brief.schema.json
- [ ] Ensure open_questions is empty, requirements has entries, constraints has entries
- [ ] Record the artifact path in progress-arm.md

### Task 5: Gate evaluation
- [ ] Validate brief.json against the schema using: `node -e "const Ajv = require('ajv'); ..."`
- [ ] Write arm-gate.json to .pipeline/runs/<run-id>/gates/arm-gate.json conforming to contracts/quality-gate.schema.json
- [ ] Gate must have status "pass" with all criteria passing, phase "arm", blocking_failures empty
- [ ] Record gate result in progress-arm.md

### Task 6: Verification
- [ ] Run: `./scripts/verify.sh --changed-only`
- [ ] Fix any failures introduced
- [ ] Record verification status in progress-arm.md

## Completion
When ALL tasks are checked off in progress-arm.md and arm-gate.json shows
status "pass", output:
<promise>ARM phase complete: requirements extracted, brief.json valid, arm-gate passed</promise>
