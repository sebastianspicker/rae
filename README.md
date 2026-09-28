<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/rae-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/rae-lockup-light.svg">
    <img alt="RAE: Reliable Agentic Engineering" src="docs/assets/brand/rae-lockup-light.svg" width="820">
  </picture>
</p>

[![ci](https://github.com/sebastianspicker/rae/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebastianspicker/rae/actions/workflows/ci.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13179/badge)](https://www.bestpractices.dev/projects/13179)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sebastianspicker/rae/badge)](https://scorecard.dev/viewer/?uri=github.com/sebastianspicker/rae)
[![License: MIT](https://img.shields.io/github/license/sebastianspicker/rae)](LICENSE)

RAE is a local-first toolkit for controlled repository changes. It combines
versioned graph workflows, isolated Git worktrees, schema-validated artifacts,
human checkpoints, verification gates, and durable local run evidence.

The repository distributes source only: there is no published package,
supported container, deployed service, or stable API. The hosted control-plane
code and workflow 2.2 are experimental.

## What RAE provides

- a graph-native workflow engine with bounded concurrency, joins, checkpoints,
  repair loops, and immutable attempt envelopes
- autonomous repository work in isolated Git worktrees, with Codex as the
  default provider and explicit macOS-only OpenCode routes
- a bearer-authenticated operator console bound to loopback
- optional local repository, run, and temporal-memory graph projections
- the independent Ralph audit, linting, and transactional fixing loop
- deterministic quality, review, trace, profile-installation, and repository
  hygiene tools
- an experimental PostgreSQL control plane, remote worker, object-store
  boundary, and HTTP MCP endpoint

RAE does not commit, push, publish, deploy, or activate workflow revisions on a
user's behalf. The custom command provider is an unsandboxed test integration,
not an operational backend. OpenCode writes require an isolated RAE worktree
and the supported macOS Seatbelt boundary.

## Screenshot tour

These are deterministic CLI captures and sanitized operator fixtures, not
evidence from a live run.

The command surface prints the supported entry points and their arguments:

![RAE umbrella CLI command map](docs/assets/screenshots/rae-cli.svg)

Autonomous runs default to checkpoints before mutation and release, and the
agent help surface shows the sandbox and provider boundaries:

![RAE autonomous agent safety defaults](docs/assets/screenshots/rae-agent-safety.svg)

The loopback operator renders run state, gates, evidence references, and human
checkpoints. Its workflow editor authors revision-controlled workflows with
synchronized Loop, Graph, Analyze, and JSON views, a pinned active revision and
digest, and an inspector for budgets, loop bounds, and gate flags.

![Operator workflow editor, desktop fixture](apps/operator/docs/screenshots/evidence-dossier-desktop.png)

The same editor reflows for narrow windows:

![Operator workflow editor, mobile fixture](apps/operator/docs/screenshots/evidence-dossier-mobile.png)

Try the [static Pages demo](https://sebastianspicker.github.io/rae/) to click
through the interface against an in-browser mock. It has no repository or
backend access. The full operator stays bearer-authenticated and loopback-only.

## Requirements

- Node.js 24 or newer, npm and Git
- CMake and a C compiler for the native filesystem bridge
- the Codex CLI for provider-backed autonomous runs or Ralph
- the OpenCode CLI for explicitly selected OpenCode routes on macOS

## Prepare a source checkout

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm run rae -- doctor
```

The build compiles strict TypeScript and the descriptor-relative filesystem
bridge. macOS requires the Xcode command-line tools; Linux requires CMake, Make
and a C compiler. Runtime commands execute compiled JavaScript.

The experimental platform has a separate lockfile and is outside the root npm
workspace. Install and build it when that package or the complete gate is in scope:

```sh
npm ci --prefix apps/platform --ignore-scripts
npm --prefix apps/platform run build
```

## Quick start

Inspect the supported command families:

```bash
npm run rae -- --help
npm run rae -- agent doctor
```

Run a task against a committed target repository in an isolated worktree:

```bash
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --task "Add a tested health endpoint and document its behavior"
```

The command prints the worktree, run ID, and
`.pipeline/runs/<run-id>/run-report.md`. Use `--through plan` to stop before a
writer node. New isolated runs use a `pipeline/<run-id>` branch and place the
worktree under the target repository's Git metadata at
`.git/rae-worktrees/<run-id>`.

Serve the local operator for explicitly allowed repositories:

```bash
npm run rae -- operator serve --project /canonical/path/to/repository
```

Run Ralph after creating its package-local `prd.json`:

```bash
npm run rae -- ralph --check
npm run rae -- ralph --mode audit 10
```

See the [engine guide](packages/engine/README.md), [operator
guide](apps/operator/README.md), and [Ralph guide](packages/ralph/README.md) for
their complete interfaces.

## Repository map

| Path | Purpose and boundary | Documentation |
| --- | --- | --- |
| `packages/engine/` | Private npm workspace package; workflow, run, provider, graph, and evidence runtime | [Engine](packages/engine/README.md) |
| `packages/contracts/` | Private workspace package exporting immutable versioned schemas | [Contracts](packages/contracts/README.md) |
| `apps/operator/` | Private workspace application; loopback console and static mock demo | [Operator](apps/operator/README.md) |
| `apps/platform/` | Separately installed experimental control plane and worker | [Platform](apps/platform/README.md) |
| `packages/ralph/` | Independent TypeScript story loop | [Ralph](packages/ralph/README.md) |
| `packages/dev-tools/` | Independently invoked TypeScript quality, review, and trace tools | [Quality gate](packages/dev-tools/quality-gate/README.md), [review](packages/dev-tools/multi-model-review/README.md), [trace](packages/dev-tools/trace-collector/README.md) |
| `workflows/` | Repository-owned workflow definitions and recipes | [Graph tutorial](docs/tutorials/graph-engineering-with-rae.md) |
| `integrations/agent-adapters/` | Adapter manifest, templates, generator, and derived runner guidance | [Adapter generation](integrations/agent-adapters/README.md) |
| `profiles/agent-environments/` | Sanitized profile templates and transactional installers | [Profiles](profiles/agent-environments/README.md) |
| `tools/repo-hygiene/` | Narrow repository-maintenance utilities | [History cleaner](tools/repo-hygiene/coauthor-trailer-cleaner/README.md) |
| `scripts/` | Umbrella CLI and repository-wide validation | [CLI reference](docs/reference/cli/umbrella.md) |

The [architecture guide](docs/ARCHITECTURE.md) describes dependency direction,
runtime flows, state ownership, and security boundaries. The [documentation
guide](docs/INDEX.md) routes readers into tutorials, how-to guides, references,
explanations, and governance.

## Configuration

Configuration is owned by the runtime that consumes it:

| Surface | Configuration entry point |
| --- | --- |
| Autonomous engine | CLI flags, `packages/engine/policies/`, workflow JSON, and optional execution profiles |
| Workflow registry and graph memory | Owner-controlled state under the target Git common directory |
| Operator | `--project`, repeatable `--execution-profile`, or remote-operator options |
| Ralph | `prd.json`, command flags, and documented `RALPH_*` variables |
| Experimental platform | `RAE_PLATFORM_CONFIG` TOML and worker environment variables |
| Public profiles | Sanitized templates under `profiles/agent-environments/` |

Do not put credentials or unrelated private material in tasks, policy files,
profiles, artifacts, reports, or committed examples. Provider-backed commands
transmit selected task and context data to the configured provider.

## Development and verification

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior. The
prepared-checkout verification command is:

```bash
npm run verify -- --skip-install
```

The command builds the source, checks maintained TypeScript and documentation,
and exercises the runtime entry points. `npm run build` covers root workspaces;
build the platform separately.

For a complete verification run:

```bash
npm run verify -- --release-candidate
```

## Support, security, and license

Use [SUPPORT.md](SUPPORT.md) for usage questions and [SECURITY.md](SECURITY.md)
for private vulnerability reporting and trust boundaries. RAE is licensed under
the [MIT License](LICENSE).
