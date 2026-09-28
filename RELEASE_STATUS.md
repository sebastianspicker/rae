# Release Status

Evidence cutoff: 2026-09-02

Verdict: NOT READY TO PUBLISH

## Candidate scope

- Proposed version: `v0.1.0-alpha.1`
- Intended artifact: reviewed source tag and optional source archive
- Published package, supported container, hosted service, or stable API: none

The candidate covers the source-checkout CLI, graph-native engine, loopback
operator, versioned contracts, Ralph, deterministic development tools,
sanitized profiles, and repository-hygiene utilities. The hosted platform and
workflow 2.2 remain experimental.

## Current worktree

The worktree contains a large uncommitted migration from the former
`packages/orchestration/` and `packages/loops/` layout into `apps/`,
`packages/engine/`, `packages/contracts/`, `packages/dev-tools/`,
`packages/ralph/`, `workflows/`, and `integrations/`. Several new
components and workflows are not yet tracked. This mutable tree is not a
release artifact.

The previous local gate record from 2026-08-30 predates the current
documentation and application changes. Its test counts and pass result are
historical evidence only; no complete current release-candidate gate is
recorded.

## Verified implementation boundaries

Current source and contract checks establish these boundaries:

- applications import the public `@rae/engine` package surface rather than
  engine internals
- versioned schemas are owned by `packages/contracts/v1/`
- the operator is loopback-only and exposes `/api/v1`
- the experimental platform exposes `/api/v2` and `/mcp`
- the operator remote relay and platform are not integrated because no API
  version adapter exists
- the platform's Compose file is a local dependency fixture, not production
  deployment configuration
- the operator Pages workflow builds a browser-only mock with no repository or
  backend access

These are implementation and source-review claims, not evidence of a clean
release, hosted deployment, or provider outcome.

## Publication blockers

- Review and track the intended migration, then reproduce all evidence from a
  clean candidate with `npm run verify -- --release-candidate`.
- Run the hosted CI, CodeQL, Scorecard, image-build, and operator-demo workflows
  against the exact candidate commit.
- Capture authenticated provider acceptance for the intended Codex and
  OpenCode release surfaces.
- Perform an interactive browser acceptance pass for the operator and its
  static mock.
- Either implement and test an operator-to-platform API adapter or continue to
  document the two HTTP surfaces as separate.
- Define production identity, TLS, database, object-store, worker isolation,
  backup, recovery, monitoring, and incident procedures before presenting the
  platform as deployable.
- Configure a private project-specific conduct-reporting address before public
  release.

## Next gate

Finish reviewing the current worktree, create a clean candidate, run the full
release procedure in [RELEASING.md](RELEASING.md), and attach every hosted and
manual result to that exact revision. Do not tag or publish while any required
lane is skipped, stale, or environment-blocked.
