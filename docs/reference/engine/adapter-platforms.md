---
status: stable
owner: core
last_reviewed: 2026-08-27
source_of_truth: integrations/agent-adapters/content/spec/adapter-manifest.json
evidence_links: ../claims/evidence-index.md
---

# Platform / adapter notes

## Core (platform-agnostic)

The core is designed to work in any environment that can read/write files and run shell commands:

- Contracts: `packages/contracts/v1/schemas/` (JSON Schemas for artifacts and quality gates)
- Canonical orchestration guidance: `integrations/agent-adapters/content/<runner>/skills/`
- Runtime skills (no paid model APIs): `packages/dev-tools/*` (`quality-gate`, `multi-model-review`, `trace-collector`)
- Run state scaffolding: `packages/engine/scripts/pipeline-init.ts` + `.pipeline/` (gitignored)
- Autonomous Codex execution: `packages/engine/src/cli/autonomous.ts`

Canonical top-level stage order:

`arm -> design -> adversarial-review -> plan -> pmatch -> build -> quality-static -> quality-tests -> post-build -> release-readiness`

## Adapters (platform-specific)

Adapters translate the playbook into the primitives of a specific IDE/runner.

- Canonical adapter root: `integrations/agent-adapters/content/<runner>/skills/`
- Source-of-truth mapping and invariants: `integrations/agent-adapters/content/spec/adapter-manifest.json`
- Canonical templates: `integrations/agent-adapters/content/templates/`
- Generator + sync-check: `integrations/agent-adapters/src/generate-adapters.ts` (`--check` mode in CI/verify)
- Supported runners: `codex`, `cursor`, `claude`, `gemini`, `kilo`
- The templates and manifest are authoritative; runner directories contain generated guidance.

The synchronized guidance adapters are portable playbooks, not claims that every
runner has an executable CLI integration. The autonomous executor
currently implements Codex CLI. An explicit `rae-agent-v1` command protocol is
available only for controlled tests and integration development; it is
unsandboxed, requires `--allow-unsafe-command-provider`, and always fails
doctor. Cursor, Claude, Gemini, and Kilo can follow their committed adapters
interactively or implement a properly sandboxed future executor; they are not
silently auto-detected as code-writing backends.

## Verification modes

- Full verification: `npm run verify --`
- Markdown integrity check (also part of verify): `node scripts/dist/check-markdown-links.js --root "$(pwd)" --allowed-root "$(pwd)/../.." --strict`

## Minimum platform capabilities

To run the pipeline as intended, a platform/runner should support:

- Scoped contexts per phase or worker, with no implicit cross-talk.
- Fresh phase sessions. The Codex executor is serial; bounded fan-out is an
  adapter capability only when an approved contract explicitly assigns it)
- Filesystem access to read the codebase and write
  `.pipeline/runs/<run-id>/...` artifacts.
- Current documentation or search access through an explicitly configured
  interface.
