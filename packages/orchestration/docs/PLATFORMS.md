# Platform / adapter notes

## Core (platform-agnostic)

The core is designed to work in any environment that can read/write files and run shell commands:

- Contracts: `contracts/` (JSON Schemas for artifacts and quality gates)
- Canonical orchestration guidance: `adapters/<runner>/skills/`
- Runtime skills (no paid model APIs): `skills/dev-tools/*` (`quality-gate`, `multi-model-review`, `trace-collector`)
- Run state scaffolding: `scripts/pipeline-init.sh` + `.pipeline/` (gitignored)
- Autonomous Codex execution: `scripts/pipeline/autonomous.mjs`

Canonical top-level stage order:

`arm -> design -> adversarial-review -> plan -> pmatch -> build -> quality-static -> quality-tests -> post-build -> release-readiness`

## Adapters (platform-specific)

Adapters translate the playbook into the primitives of a specific IDE/runner.

- Canonical adapter root: `adapters/<runner>/skills/`
- Source-of-truth mapping and invariants: `adapters/spec/adapter-manifest.json`
- Canonical templates: `adapters/templates/`
- Generator + sync-check: `scripts/adapters/generate_adapters.py` (`--check` mode in CI/verify)
- Supported runners: `codex`, `cursor`, `claude`, `gemini`, `kilo`
- `adapters/` is the authoritative source for all runner stage guidance.

The synchronized guidance adapters are portable playbooks, not claims that every
runner has an executable CLI integration. The autonomous executor
currently implements Codex CLI. An explicit `rae-agent-v1` command protocol is
available only for controlled tests and integration development; it is
unsandboxed, requires `--allow-unsafe-command-provider`, and always fails
doctor. Cursor, Claude, Gemini, and Kilo can follow their committed adapters
interactively or implement a properly sandboxed future executor; they are not
silently auto-detected as code-writing backends.

## Verification modes

- Full verification: `./scripts/verify.sh`
- Diff-aware fast verification: `./scripts/verify.sh --changed-only [--changed-base <git-ref>]`
- Markdown integrity check (also part of verify): `python3 scripts/check-markdown-links.py --root "$(pwd)" --allowed-root "$(pwd)/../.." --strict`

## Minimum platform capabilities

To run the pipeline as intended, a platform/runner should support:

- Scoped contexts per phase or worker, with no implicit cross-talk.
- Fresh phase sessions. The Codex executor is serial; bounded fan-out is an
  adapter capability only when an approved contract explicitly assigns it)
- Filesystem access to read the codebase and write
  `.pipeline/runs/<run-id>/...` artifacts.
- Current documentation or search access through an explicitly configured
  interface.
