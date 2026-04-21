---
status: draft
owner: core
last_reviewed: 2026-04-17
source_of_truth: ../../../README.md
evidence_links: ../../research/benchmark-protocol.md
---

# Repo Audit Remediation Plan

This plan converts the 2026-04-17 repo audit into an implementation sequence that can be executed iteratively and autonomously.

## Assumptions

- The goal is to remediate the verified audit findings without broad redesign.
- The preferred approach is the smallest correct change set per issue.
- Verification must become stricter, not looser, unless a documented repo contract is intentionally changed.
- Work should remain autonomous unless an issue reveals a truly irreversible product-policy decision.

## Success Criteria

The remediation is complete when all of the following are true:

- `./scripts/verify.sh` passes from the repo root.
- Root verification accurately fails when required subsystems or contracts are broken.
- Ralph read-only modes cannot mutate the workspace through allowed tools.
- The coauthor cleaner cannot rewrite or push an unintended remote.
- Release-gate enforcement matches benchmark metadata, including required splits.
- Orchestration artifact, schema, and trace contracts are internally consistent.
- Worktree-backed orchestration runs resume against the correct workspace automatically.
- Eval metadata naming and schema rules are internally consistent.
- Profile install/uninstall behavior is safe for existing user config and truthful about supported targets.
- New regression tests cover each fixed defect.

## Execution Rules

- Implement one iteration at a time.
- Start each defect with a failing or coverage-extending test when practical.
- After each iteration, run the smallest relevant verification slice first, then broader repo verification.
- Do not begin lower-priority cleanup until all blocking verification and safety defects are closed.
- If a change touches contracts or file naming, update tests and docs in the same iteration.

## Workstreams

### A. Verification and eval harness correctness

- Fix the root verifier/output-dir contract mismatch.
- Make root verification authoritative and honest about skipped checks.
- Reconcile eval run-card naming and benchmark schema inconsistencies.
- Make release gating enforce benchmark-declared publication requirements.

### B. Runtime safety and destructive-operation guardrails

- Enforce true read-only behavior in Ralph audit and linting modes.
- Harden Ralph state import and append helpers against invalid or escaping input.
- Make the coauthor cleaner require an explicit remote match before rewrite/push.
- Prevent tag publication from bypassing cleaned-history guarantees.

### C. Orchestration contract integrity

- Prevent empty requirement briefs from passing early gates.
- Align trace-collector output with its published schema.
- Make worktree metadata operational, not merely persisted.
- Remove runtime assumptions that break under alternate Node resolution.

### D. Profile and operator-surface reliability

- Make the profile lane safe to install into existing targets.
- Narrow or clarify support claims for non-RAE targets.
- Improve `doctor` to surface real prerequisites for the shipped verification path.

## Iteration Plan

## Iteration 0: Baseline and branch discipline

Objective: establish a stable implementation baseline and preserve reproducibility.

Tasks:

- Re-run and capture the current failing root verification path.
- Record the exact failing command chain and artifact path assumptions.
- Confirm current package-level green baseline for Ralph, orchestration, eval tests, profile tests, and coauthor cleaner tests.

Primary files:

- `scripts/verify.sh`
- `evals/scripts/run_benchmark.py`
- `evals/harness/run-frozen-suite.sh`

Verification:

- `./scripts/verify.sh`
- `python3 -m pytest evals/tests`
- `./packages/loops/ralph/scripts/run_tests.sh`
- `bash ./tools/repo-hygiene/coauthor-trailer-cleaner/tests/run-tests.sh`

Exit criteria:

- Root failure mode is reproducible and understood.
- No unrelated failing baseline exists.

## Iteration 1: Unblock authoritative root verification

Objective: make repo-level verification truthful and passable on a correctly provisioned machine.

Tasks:

- Fix `scripts/verify.sh` so every eval output path it creates is under `evals/results/`.
- Remove any temp-path assumptions that conflict with `run_benchmark.py` and `run-frozen-suite.sh`.
- Decide and implement one repo-wide policy for skipped checks:
  `verify.sh` should either fail when required tooling is missing or emit `VERDICT: PARTIAL` rather than `PASS`.
- Tighten `scripts/rae.sh doctor` so it checks all commands actually needed by top-level verification, including `rg`.
- Improve doctor entrypoint validation where executable or downstream runtime integrity matters.

Primary files:

- `scripts/verify.sh`
- `scripts/rae.sh`
- `profiles/agent-environments/tests/profile-installation.sh`

Tests to add/update:

- Root verifier regression covering eval output location.
- Doctor regression covering `rg` dependency reporting.
- If behavior changes, snapshot/help-text expectations for doctor output.

Verification:

- `./scripts/verify.sh`
- `bash ./scripts/rae.sh doctor`
- `bash ./evals/harness/run-local.sh doctor`

Exit criteria:

- Root verify passes on this machine.
- A missing required dependency no longer yields a misleading root `VERDICT: PASS`.

## Iteration 2: Fix safety-critical destructive and write-scope defects

Objective: close the highest-risk repo mutation vulnerabilities first.

Tasks:

- In Ralph, make read-only modes actually read-only for Claude runs.
- Prefer a deny-by-default tool set for read-only mode rather than blocking only edit primitives.
- Add explicit regression coverage proving shell-based writes are not possible in `audit` and `linting`.
- Validate imported Ralph state before persisting it back into `prd.json`.
- Harden append helpers against symlink/path-escape writes if they are intended to be repo-confined.
- In the coauthor cleaner, require the provided GitHub URL to resolve to exactly one matching remote before destructive actions.
- Prevent tag force-pushes from re-publishing uncleaned history, or fail hard when tag state is inconsistent.

Primary files:

- `packages/loops/ralph/lib/ralph/runner_tool.sh`
- `packages/loops/ralph/lib/ralph/state_io.sh`
- `packages/loops/ralph/scripts/lib/append_safe.sh`
- `tools/repo-hygiene/coauthor-trailer-cleaner/coauthor-trailer-cleaner.sh`

Tests to add/update:

- Ralph read-only mutation regression tests.
- Ralph import-state schema/type guardrail tests.
- Append-helper confinement/symlink tests.
- Coauthor cleaner remote-match and tag-publication regressions.

Verification:

- `./packages/loops/ralph/scripts/run_tests.sh`
- `bash ./tools/repo-hygiene/coauthor-trailer-cleaner/tests/run-tests.sh`
- `./scripts/verify.sh`

Exit criteria:

- Read-only Ralph runs cannot mutate the repo through allowed tools.
- Coauthor cleaner destructive actions are impossible without an exact remote match.

## Iteration 3: Repair orchestration contract and schema integrity

Objective: ensure the long-horizon runtime enforces its own core guarantees.

Tasks:

- Require at least one requirement, and preferably at least one `must`, in the brief contract or stage gate.
- Add gate criteria so arm/design/plan do not pass with structurally empty but schema-valid artifacts.
- Change traceability semantics so `0/0` does not count as full requirement coverage where that would hide missing planning.
- Align trace-collector output schema with emitted fields, or remove undeclared fields from output.
- Add a contract test that validates real trace-collector output against `schemas/output.schema.json`.

Primary files:

- `packages/orchestration/contracts/artifacts/brief.schema.json`
- `packages/orchestration/scripts/pipeline/lib/gates.mjs`
- `packages/orchestration/scripts/pipeline/lib/traceability.mjs`
- `packages/orchestration/skills/dev-tools/trace-collector/src/lib/trace.ts`
- `packages/orchestration/skills/dev-tools/trace-collector/schemas/output.schema.json`

Tests to add/update:

- Arm-gate empty-requirement failure test.
- Traceability regression for empty-source behavior.
- Trace-collector schema conformance test.

Verification:

- `cd packages/orchestration && ./scripts/verify.sh`
- `./scripts/verify.sh`

Exit criteria:

- Empty-requirement briefs cannot pass as valid planning input.
- Trace-collector outputs validate against shipped schemas.

## Iteration 4: Make worktree and subprocess behavior operationally correct

Objective: close correctness gaps that appear when orchestration runs outside the main checkout.

Tasks:

- Make runner commands derive workspace root from persisted run state when a run already exists.
- Ensure `loadPipelineState`, run directories, and spawned skill tools use the resolved workspace root consistently.
- Replace hardcoded `node` subprocess invocation with `process.execPath` or an equivalent runtime-stable resolution.
- Add explicit worktree resume tests that prove commands invoked from the primary repo still operate on the isolated run workspace.

Primary files:

- `packages/orchestration/scripts/pipeline/lib/state.mjs`
- `packages/orchestration/scripts/pipeline/runner.mjs`
- `packages/orchestration/scripts/pipeline/lib/subprocess.mjs`

Tests to add/update:

- Worktree resume integration regression.
- Alternate-runtime subprocess spawn regression.

Verification:

- `cd packages/orchestration && ./scripts/verify.sh`
- `./scripts/verify.sh`

Exit criteria:

- Worktree runs resume correctly without caller `cd` discipline.
- Skill tool spawning does not depend on `node` being discoverable under that exact name.

## Iteration 5: Repair eval metadata, release-gate policy, and naming consistency

Objective: make the measurement layer internally consistent and publication-safe.

Tasks:

- Enforce `release_gate.required_splits` in `release_gate.py`.
- Make judge calibration gating inspect quality thresholds rather than file existence only.
- Reconcile run-card discovery patterns between emitted names and metadata validators.
- Reconcile `benchmark-card.schema.json` with actual `task_specs_path` usage under `evals/datasets/`.
- Add schema and integration tests to stop naming drift from recurring.

## Thesis validation

This remediation plan validates defects and fix priorities per workstream rather
than asserting that the repo is already fully trustworthy. It is a provisional
engineering plan with explicit success criteria and verification surfaces.

## Interpretation limits

- the plan is a scoped response to a dated audit and can drift as the codebase
  changes

## Source note

- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../../reference/claims/bibliography.md#src-nosek-open-research)

Primary files:

- `evals/scripts/release_gate.py`
- `evals/scripts/validate_eval_metadata.py`
- `evals/harness/run-local.sh`
- `evals/schemas/benchmark-card.schema.json`
- `evals/scripts/run_benchmark.py`

Tests to add/update:

- Release-gate regression for missing required split evidence.
- Calibration-threshold gate regression.
- Metadata validator regression for generated run-card names.
- Benchmark-card schema test for real benchmark fixtures.

Verification:

- `python3 -m pytest evals/tests`
- `bash ./evals/harness/run-local.sh validate`
- `bash ./evals/harness/run-local.sh suite evals/results/.plan-suite`
- `./scripts/verify.sh`

Exit criteria:

- Publication gates align with benchmark metadata.
- Metadata validation covers the files the harness actually generates.

## Iteration 6: Fix profile install safety and support-contract accuracy

Objective: make the public profile lane safe and truthful.

Tasks:

- Add backup, refusal, or explicit `--force` behavior before overwriting existing `.codex/config.toml`, `.claude/settings.json`, or `docs/agent-operator-policy.md`.
- Make uninstall remove only files installed by this profile, not arbitrary pre-existing files.
- Mark installed files with provenance metadata if needed.
- Either narrow README/install claims to RAE-shaped targets or make templates degrade safely when `./scripts/verify.sh` is unavailable.
- Extend installer tests to cover existing-config scenarios.

Primary files:

- `profiles/agent-environments/installers/install-profile.sh`
- `profiles/agent-environments/installers/uninstall-profile.sh`
- `profiles/agent-environments/README.md`
- `profiles/agent-environments/tests/profile-installation.sh`

Tests to add/update:

- Existing-config preservation regression.
- Uninstall provenance regression.
- Template expectation regression for supported target shape.

Verification:

- `bash ./profiles/agent-environments/tests/profile-installation.sh`
- `./scripts/verify.sh`

Exit criteria:

- Installer is safe in repos with existing local config.
- README claims match actual behavior.

## Iteration 7: Root-surface hardening and residual quality issues

Objective: close remaining non-blocking correctness and portability issues discovered during the audit.

Tasks:

- Harden Markdown verification to reject links escaping the repo root.
- Make frontmatter parsing tolerate CRLF line endings.
- Reduce regex-based link false positives where practical.
- Review Ralph portability concerns such as GNU-only `sort -z` and ineffective Perl timeout fallback.
- Re-run a full repo search for TODO/FIXME/HACK debt introduced or exposed during remediation.

Primary files:

- `scripts/verify_repo.py`
- `packages/loops/ralph/lib/ralph/aggregate.sh`
- `packages/loops/ralph/lib/ralph/runner_tool.sh`

Tests to add/update:

- Link-escape regression.
- CRLF frontmatter regression.
- macOS-portability regression for Ralph aggregation/timeout handling where feasible.

Verification:

- `python3 scripts/verify_repo.py`
- `./packages/loops/ralph/scripts/run_tests.sh`
- `./scripts/verify.sh`

Exit criteria:

- Root docs verification is reproducible across supported environments.
- Known portability hazards are either fixed or explicitly documented with tests.

## Autonomous Execution Strategy

Implementation should proceed in this order:

1. Iteration 1
2. Iteration 2
3. Iteration 3
4. Iteration 4
5. Iteration 5
6. Iteration 6
7. Iteration 7

Reasons for this order:

- Root verification must be trustworthy before using it as a global gate.
- Safety-critical write and push defects outrank contract polish.
- Contract/schema correctness should be fixed before broader workflow hardening.
- Worktree/runtime corrections depend on stabilized contracts.
- Profile and docs hardening can safely follow once core runtimes and evals are correct.

## Per-Iteration Completion Checklist

- New or updated tests fail before the fix and pass after the fix.
- The smallest relevant subsystem verification passes.
- No previously passing higher-level check regresses.
- Docs and help text reflect changed behavior.
- The root verifier is re-run after each completed iteration from Iteration 1 onward.

## Final Closure Conditions

Before closing the remediation effort, run all of the following from repo root:

- `python3 scripts/verify_repo.py`
- `bash ./evals/harness/run-local.sh validate`
- `python3 -m pytest evals/tests`
- `./packages/loops/ralph/scripts/run_tests.sh`
- `bash ./tools/repo-hygiene/coauthor-trailer-cleaner/tests/run-tests.sh`
- `bash ./profiles/agent-environments/tests/profile-installation.sh`
- `cd packages/orchestration && ./scripts/verify.sh`
- `./scripts/verify.sh`

Expected closure verdict:

- `VERDICT: PASS`
