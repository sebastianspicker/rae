# Release Status

Evidence cutoff: 2026-07-24

Verdict: DOCUMENTATION AND AVAILABLE FOCUSED GATES PASS; NOT READY TO PUBLISH

## Candidate identity

- Proposed version: `v0.1.0-alpha.1`
- Branch: `docs-security-badges`
- Baseline HEAD: `b3a5b635032b996f943749583e93d714dc8e0ae3`
- Components: Ralph `0.3.0`; coauthor trailer cleaner `3.0.0`
- Candidate state: 309 modified, 27 deleted, and 154 untracked paths;
  zero staged files; untagged, uncommitted, and unpublished
- Branch state: the configured upstream is gone; the cached `origin/main` is
  14 commits ahead of this baseline

## Verified local evidence

- `python3 -B scripts/verify_repo.py --skip-mkdocs` passes source headers,
  obsolete-artifact checks, deterministic screenshots, brand assets,
  frontmatter, local link paths, citation density, and evaluation metadata.
- `pyright --project pyrightconfig.json` reports zero errors, warnings, or
  informational diagnostics.
- Existing candidate Bash entrypoints pass syntax checking and ShellCheck.
  Candidate Python files compile with bytecode redirected outside the
  repository.
- Ralph passes 63 of 63 tests in the current working tree. Its transaction tests
  cover protected metadata placement, real Codex sandbox denial, native
  no-clobber promotion and recovery, concurrent-entry preservation, read-only
  directory subtrees, crash checkpoints, retained conflict evidence,
  idempotent recovery, and partial terminal cleanup.
- The coauthor trailer cleaner passes 65 of 65 tests. The public profile
  transaction suite, root runtime contract, and evaluation metadata validator
  pass.
- The authenticated loopback operator console passes 25 of 25 control,
  security, server, recovery, and UI-contract tests.
- Focused adversarial regressions reproduce the orchestration recovery race and
  Ralph transaction overwrite and cleanup cases, and those regressions pass.
  The remaining boundaries are documented in `SECURITY.md` and the package
  security files.
- Orchestration's dependency-free skill validation, stale-reference check,
  hygiene check, 11-file strict link check, adapter synchronization, package
  integrity, operator suite, and JavaScript syntax checks pass.
- All 107 candidate JSON files and 18 YAML/CFF files parse. Every referenced
  `src-*` bibliography key has a matching explicit bibliography anchor. All
  versioned root-lock `node_modules` entries include `resolved` and `integrity`.
- The two deterministic SVG command captures are current, reproducible, and
  free of private paths. The 1280 by 640 social preview is visually legible and
  contains no slogan, credential, or private machine content.
- `./scripts/rae.sh doctor` passes with GNU Bash `5.3.15`, Python `3.14.6`,
  Node.js `22.23.1`, Git, `rg`, npm, `jq`, ShellCheck, and git-filter-repo.
  `./scripts/rae.sh agent doctor` confirms the installed Codex path is
  authenticated and exposes the required sandbox, structured-output, event,
  and ephemeral-session capabilities.

## Verification limits and publication blockers

- `./scripts/verify.sh --skip-install` stops because `ruff` is not installed.
  The current environment also lacks `pytest`, `mkdocs`, and `lizard`, so the
  complete Python suite, strict MkDocs build, complexity gate, and umbrella
  verifier are not available. No dependency installation was authorized.
- `packages/orchestration/scripts/verify.sh --skip-install` passes its first six
  dependency-free gates, then the `_shared` TypeScript build stops because the
  local installation lacks `ajv`, `ajv-formats`, and Node type declarations.
  `npm run test:runner` cannot find the local Vitest executable. A clean
  `npm ci`, package build, and full package test lane remain required.
- The in-app browser has no available browser, and no Playwright installation
  is present. The operator console therefore has contract-test coverage but no
  final live render, console inspection, viewport review, interaction smoke,
  or sanitized operator screenshot.
- No clean isolated installation, disposable real-provider outcome run, sealed
  held-out evaluation, optimizer recommendation, or live release-candidate
  browser smoke was performed.
- The project still lacks a private conduct-reporting address. GitHub's content
  reporting controls cover conduct on GitHub, but a project-specific private
  route is required before publication.
- The working-tree secret scan found only a synthetic operator test match. No
  Gitleaks configuration or history scan is present, so this is working-tree
  evidence rather than a complete secret-history audit.
- `python3 -B scripts/verify_repo.py --release-candidate` correctly rejects the
  dirty worktree. GitHub CI, CodeQL, Scorecard, badges, external links, and the
  public release page cannot be confirmed until an approved candidate commit
  exists.
- The recorded test results describe this mutable working tree, not an immutable
  release artifact. The final candidate commit and hosted checks must anchor the
  publication evidence.
- The candidate must be reconciled onto refreshed `main`; the current branch
  upstream is gone and cached `origin/main` is ahead.

## Accepted alpha boundaries

This source candidate implements local, experimental autonomous workflows. It
does not claim a stable API, remote operation, unsandboxed safety, universal
agent reliability, or provider-backed performance. The custom command provider
is an explicitly unsafe test surface. Ralph multi-path promotion is recoverable
but not globally atomic, and its concurrent-entry guarantee assumes stable
parent directories. These limits are acceptable only when they remain visible
in the alpha documentation and release notes.

No file was staged, committed, tagged, pushed, released, or published during
this preparation pass.

## Next gate

Before publication, provide a private conduct-reporting route, restore the
pinned Python and Node dependencies in an authorized isolated environment, and
run the complete commands in `RELEASING.md`. Then perform the browser and
provider smoke lanes, reconcile the reviewed candidate onto refreshed `main`,
create the approved candidate commit, run
`./scripts/verify.sh --release-candidate`, and confirm the hosted workflows.
Only then should the maintainer create `v0.1.0-alpha.1` and its release.
