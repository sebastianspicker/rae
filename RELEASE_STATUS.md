# Release Status

Evidence cutoff: 2026-08-04

Verdict: LOCAL IMPLEMENTATION GATES PASS; NOT READY TO PUBLISH

## Candidate scope

- Proposed version: `v0.1.0-alpha.1`
- Distribution: reviewed source tag and optional source archive
- Published package, container, hosted service, or stable API: none
- Current working tree: uncommitted and unsuitable as a release artifact

The candidate scope is the local source toolkit: graph-native repository
workflows, isolated worktrees, the loopback operator, evaluation tools, Ralph,
and repository-maintenance utilities. The hosted-platform package and workflow
2.2 remain experimental.

## Implemented local surface

- Workflow 2.1 supports typed nodes and edges, bounded fan-out, deterministic
  transforms, first-success and quorum joins, checkpoints, and bounded cycles.
- The loopback operator provides synchronized Loop, Graph, Analyze, and JSON
  views. Five guided templates compile directly to workflow 2.1.
- Workflow analysis reports schema and topology diagnostics, unreachable nodes,
  writer and verification paths, bounded attempts and dynamic instances,
  concurrency, and resolved execution routes.
- Execution profile 3.0 maps logical tiers and optional node overrides to named
  Codex or OpenCode routes without adding provider configuration to workflows.
- Workflow proposals remain drafts. Preview, revision saving, validation, diff,
  and exact-digest activation are separate operator actions. Activation affects
  future runs only.
- OpenCode is explicit, never selected by `auto`, and supported only through the
  documented macOS containment backend. OpenCode writes require an isolated RAE
  worktree and reject `--in-place`.

## Verified local evidence

- `packages/orchestration/scripts/verify.sh --skip-install` passes the package
  builds, lint and format checks, runner, operator, shared-runtime,
  quality-gate, review, and trace-collector suites.
- The pipeline runner passes 396 tests. The operator passes 42 tests.
- `python -m pytest evals/tests tests` passes 74 tests under Python 3.14.6.
- Ruff, Pyright, Lizard, the root runtime contract, evaluation validation,
  profile installation, Ralph's 63 tests, and the co-author cleaner's 65 tests
  pass in the current working tree.
- OpenCode doctor passes locally with OpenCode 1.18.11 and verifies the exact
  denied-by-default tool surface under macOS Seatbelt.
- Real Seatbelt checks deny read-node writes and deny write-node access outside
  the isolated workspace, including `.pipeline`. The verification broker runs
  its approved Git check under a nested no-network sandbox.
- `git diff --check` passes.

These results apply to the current mutable checkout. They are not evidence for
an immutable tag, hosted deployment, arbitrary repository, or provider-backed
task outcome.

## Publication blockers

- The root `./scripts/verify.sh --skip-install` gate stops at repository
  validation because `docs/assets/screenshots/rae-agent-safety.svg` is stale
  relative to its deterministic generator. The complete root gate therefore
  does not pass.
- No authenticated OpenCode proposal or write run has captured a real provider
  event stream and completed the full designer-to-activation acceptance path.
- No final browser render, responsive interaction, console, or screenshot smoke
  was performed. The in-app browser was unavailable and Playwright is not
  installed in the current environment.
- The working tree contains extensive uncommitted changes. Release-candidate
  verification requires a reviewed, committed candidate with current hosted CI
  and security checks.
- The project still needs a private conduct-reporting address before
  publication.

## Experimental boundaries

The hosted control-plane and worker package is not deployed. Source-unit tests
do not establish PostgreSQL migration and reconciliation, OIDC issuer
interoperability, object-storage transfer, remote worker isolation, secret
handling, hosted recovery, or production operations.

Workflow 2.2 implements local durable waits, typed signals, and bounded context
assembly. It has no context-efficiency result. A frozen comparison with the
predefined threshold remains required before making such a claim.

OpenRouter models are supported only through OpenCode provider configuration.
RAE does not call the OpenRouter API directly. The OpenCode adapter is macOS
only in this candidate.

## Next gate

Regenerate and review the stale deterministic screenshot, complete the root
verification gate, and run the authenticated OpenCode and browser acceptance
lanes. Then review and commit the candidate, run
`./scripts/verify.sh --release-candidate`, and confirm the hosted checks against
that exact commit before creating a tag or release.
