# RAE v0.1.0-alpha.1

These are the proposed notes for the first public alpha. They describe the
reviewed source candidate and must not be published until the release procedure
and hosted checks pass.

## Release scope

The release artifact is the tagged source tree. It contains:

- the `scripts/rae.sh` umbrella command router;
- phased orchestration, an experimental autonomous workflow, and an
  authenticated loopback operator console;
- the Ralph audit, lint, and fixing loop;
- the coauthor trailer cleaner;
- evaluation schemas, fixtures, local benchmark runners, and release gates;
- sanitized agent-environment profile templates and installers;
- the MkDocs documentation source and deterministic CLI captures.

RAE does not publish a package, container, hosted service, or stable API in this
release.

## Requirements

- GNU Bash 5.3 or newer
- Python 3.14.6 or newer
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`, with npm
- Git, `jq`, `rg`, and ShellCheck
- the hash-pinned Python dependencies in `requirements-ci.txt`, or
  `requirements-macos.txt` on macOS with Python 3.14
- the orchestration dependencies installed from
  `packages/orchestration/package-lock.json`
- an installed and authenticated Codex CLI only for provider-backed agent runs

## Alpha limitations

- Interfaces, schemas, defaults, and file formats may change between alpha
  releases.
- Autonomous execution is experimental. A passing run is evidence about its
  recorded task and checks, not a general reliability or safety guarantee.
- The operator console listens only on loopback and provides no remote service
  or publication controls.
- The CLI-only custom command provider is an unsafe testing surface without
  filesystem or network containment. It requires a fresh explicit opt-in on
  every resume and is not exposed by the operator console.
- Ralph fixing promotion is journaled per path rather than globally atomic. A
  crash may expose a partial promotion until recovery. Native no-clobber
  installation is supported on macOS and Linux and fails closed elsewhere;
  adversarial parent-directory replacement is outside the current guarantee.
- Autonomous crash recovery can fail closed when the recorded guard process ID
  may still be active. Detached custom-provider descendants also remain
  containment-uncertain and require manual workspace inspection.
- Deterministic fixtures do not establish provider-backed performance.
- No compatibility guarantee is made for operating systems or runtime versions
  outside the documented ranges.

## Upgrade and migration notes

This is the first RAE release, so there is no earlier umbrella release to
upgrade from. Ralph 0.3.0 is Codex-only; configuration for removed Claude tool
aliases is not supported. Existing component users should review the component
changelogs before moving state or automation to this source tree.

## Verification requirement

Publication requires the complete process in [RELEASING.md](RELEASING.md),
including `./scripts/verify.sh --release-candidate` from a clean candidate and
the hosted workflow checks. Current local evidence and unresolved blockers are
recorded in [RELEASE_STATUS.md](RELEASE_STATUS.md).
