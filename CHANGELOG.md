# Changelog

Notable public changes to the RAE umbrella are recorded here. Component
packages retain their own changelogs where applicable.

## [0.1.0-alpha.1] - Unreleased

### Added

- Autonomous `agent doctor|run|resume|status|stop|resolve-checkpoint|events`
  workflow with isolated Git worktrees, typed phase artifacts, plan ownership
  checks, command evidence, durable human control, and a reviewed release
  handoff.
- Authenticated loopback operator console with allowlisted project roots,
  checkpoint decisions, bounded event projection, and no publish controls.
- Public agent-profile installation and removal with manifest v2 integrity,
  no-follow filesystem transactions, rollback, and retained recovery evidence.
- Deterministic CLI screenshots produced from the current executable surface.
- Public alpha release metadata, contribution guidance, issue forms, pull
  request template, support boundary, governance, and release procedure.
- Pinned GitHub Actions for CI, CodeQL, and Scorecard, plus Dependabot, Ruff,
  Pyright, Lizard, and hashed Python verification configuration.

### Changed

- Raised the supported runtime floor to GNU Bash 5.3 and Python 3.14.6.
- Enforced the orchestration dependency contract at Node.js
  `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`.
- Updated Ralph to `0.3.0`: Codex-only execution, bounded subprocess output and
  deadlines, sanitized environments, and transactional fixing-mode writes.
- Updated the coauthor trailer cleaner to `3.0.0`: private rewrite refs, exact
  compare-and-swap promotion, exact push leases, and atomic cleanup.
- Aligned public documentation with the autonomous, deterministic-loop,
  profile, evaluation, and repo-hygiene surfaces.
- Added purpose-and-rationale headers across executable source files plus a
  release gate that prevents undocumented source modules from entering the
  public candidate.

### Removed

- Obsolete runtime compatibility paths and superseded test surfaces.

### Security

- Hardened profile install/uninstall against symlink, parent-swap, hard-link,
  concurrent-edit, rollback, and recovery races.
- Hardened history rewriting against concurrent branch movement and partial
  recovery-ref cleanup.
- Added strict runtime, path, environment, output-size, timeout, and
  public-surface hygiene checks.
- Added autonomous-run postconditions for worktree HEAD/current-branch reflogs,
  index visibility, and remote configuration, including resume preflight
  rejection.
- Protected autonomous `.pipeline` state with an external owner-only byte
  guard, atomic single-claim recovery, and retryable evidence that restores and
  reverifies unauthorized workspace-phase changes before run state is consumed.
- Required fresh unsafe authorization and command arguments on every custom
  command-provider resume, confined task files to approved project text files,
  and restricted provider child environments.
- Moved Ralph fixing providers into external transaction workspaces with
  identity-bound recovery, atomic per-entry quarantine, native no-clobber
  installation, and retained conflict evidence.

### Notes

- This is a public alpha candidate, not a stable API commitment.
- The candidate remains local, dirty, untagged, and unpublished; see
  [RELEASE_STATUS.md](RELEASE_STATUS.md) for exact evidence and blockers.
