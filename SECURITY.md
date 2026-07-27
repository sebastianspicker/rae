# Security Policy

## Reporting route

Please report security issues privately before opening a public issue.

- Preferred route: [private GitHub security advisory](https://github.com/sebastianspicker/rae/security/advisories/new).
- Include: affected path(s), reproduction steps, impact, and whether public
  disclosure appears to have already occurred.

Do not include live secrets in the initial report.

## Scope

This repository contains executable orchestration, loop, evaluation, profile,
and repository-maintenance code. It is a public alpha candidate for
`v0.1.0-alpha.1`; interfaces may change and the current checkout is not a
published release.

Supported scope for coordinated handling:

- the default branch of this repository
- committed package runtimes under `packages/`
- committed umbrella scripts under `scripts/`
- committed tooling under `tools/`
- committed eval harness and schemas under `evals/`
- committed public profile lane content under `profiles/agent-environments/`

Out of scope:

- private overlays or unpublished downstream copies
- local runtime artifacts under ignored temp/result locations
- third-party hosted services not controlled by this repository

Reports about provider-side storage, retention, account handling, or model
behavior should also be sent to the provider that controls that service. A RAE
report is still appropriate when repository code sends data beyond its
documented boundary.

Do not publish:

- secrets
- tokens
- local machine paths that expose private structure without reason
- personal debug logs
- private overlay material extracted from non-public repos

## Handling expectations

- acknowledgement target: within 7 calendar days
- initial triage target: within 14 calendar days
- coordinated fix/disclosure timing depends on severity and reproducibility
- if the report is out of scope, the response should say so explicitly

## Current security boundaries

### Autonomous orchestration

- The supported Codex path requires workspace sandboxing, structured output,
  JSON event streaming, and a fresh session for each phase.
- Provider requests contain the task, phase guidance, and selected predecessor
  artifacts. Absolute POSIX, Windows, UNC, and `file:` URL path tokens are
  sanitized before request construction; the local Codex process still receives
  the working directory and schema path required for execution. Do not put
  secrets or unrelated private content in tasks or artifacts. RAE makes no
  provider-side retention claim.
- Codex and operator-launched children receive an explicit environment
  allowlist for runtime paths, authentication, proxies, certificates, locale,
  and temporary directories. Other ambient variables are removed.
- `--task-file` accepts only relative, regular, non-symlink `.md` or `.txt`
  files below the canonical project root. It rejects credential-like paths,
  traversal, invalid UTF-8, empty files, and files larger than 128 KiB.
- Before a workspace-write phase, the runner stores an owner-only byte snapshot
  of `.pipeline` under runner state outside the workspace and provider-writable
  temporary roots. Recovery atomically claims that evidence before touching
  `.pipeline`; contenders do not mutate state. A caught restore failure
  republishes intact evidence for a later retry. Unauthorized changes are
  restored and reverified before run state is read or reported. Recovery fails
  closed while a phase or recovery claimant may still be active or when
  repository identity cannot be proved.
- The custom `command` provider is an explicitly unsafe test and integration
  surface. It has no filesystem or network sandbox, always fails `agent doctor`,
  and requires fresh command, arguments, and unsafe authorization on every
  resume. A same-user command can escape RAE's filesystem controls or leave
  detached descendants.

### Ralph fixing mode

- Audit and linting modes are read-only.
- Fixing providers edit an external transaction workspace. Immutable baseline
  data and identity-bound journals remain outside the provider workspace and
  provider-writable temporary roots.
- For an existing entry, promotion atomically moves the live entry to a
  journaled quarantine, validates it against the baseline, then installs the
  staged entry with a native no-clobber rename. New entries use the no-clobber
  install directly. Concurrent target entries are preserved and conflict
  evidence is retained.
- Recovery uses the same quarantine and no-clobber protocol only for journaled
  evidence. Multi-path promotion is recoverable but not globally atomic, so a
  crash can expose a partial promotion until recovery runs.
- Native no-clobber support is implemented for macOS and Linux; unsupported
  platforms fail closed. The concurrent-entry guarantee assumes stable parent
  directories because live renames are not descriptor-anchored.
- Hard links, special files, nested repositories, and submodules are rejected
  in fixing targets.

### Operator console and documentation site

- The operator console binds only to loopback. It prints an ephemeral bearer
  token in the URL fragment, removes the fragment from browser history, and
  keeps the token in browser memory. Project roots must be explicitly
  allowlisted.
- Projected operator events omit raw provider requests, model messages, provider metadata,
  token details, and host filesystem paths. Full redacted provider traces remain
  local under the run directory.
- Interrupt uses POSIX process groups but cannot prove termination of a child
  that deliberately creates a new session. Such runs report containment as
  uncertain and require manual inspection before reuse.
- The built documentation site loads the exact MathJax 3.2.2 browser bundle
  from jsDelivr. Building the documentation is local, but viewing pages that
  use that script makes a request to that third-party CDN.

### Repository and evaluation data

- Public agent profiles must remain machine-agnostic.
- Public profile installers must refuse symlinked managed paths and manifest
  backup paths that escape the target tree.
- Benchmark artifacts must avoid sensitive repository content.
- Maintenance tooling examples must avoid destructive defaults.
- Evaluation and publication gates must reject forged or out-of-bounds
  evidence.
