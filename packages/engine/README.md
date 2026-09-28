# RAE workflow engine

`@rae/engine` is the private workspace package behind RAE's autonomous,
workflow, graph, and operator surfaces. It validates versioned contracts,
executes immutable workflow snapshots, coordinates provider processes, and
records local run evidence.

The repository distributes source rather than a stable library release.
`src/public/index.ts` is nevertheless the only supported import boundary for
applications in this monorepo; all other files under `src/` are private.

## Install and verify

From the repository root:

```bash
npm ci
npm run test:engine
npm --workspace @rae/engine run build
```

The complete repository gate is `npm run verify -- --skip-install`. See
[Testing](../../TESTING.md) for the full matrix.

## Public package surface

The package exports:

- Node runtime compatibility checks and engine entry-point paths
- provider diagnostics and the minimal child environment
- trace append and operator event projection
- runtime-state guard inspection and recovery checks
- checkpoint, stop, and run-status controls
- graph and memory status
- execution-profile loading and route resolution
- workflow loading, validation, digesting, registry access, proposal,
  analysis, and template compilation

Consumers import these functions from `@rae/engine`. Applications must not
import `packages/engine/src/*`, duplicate versioned schemas, or depend on CLI
implementation files.

## Workflow execution

New autonomous runs resolve their workflow in this order:

1. an explicit `--workflow` file;
2. the locally activated workflow revision;
3. `workflows/graph-native-default.workflow.json`.

The engine validates and canonicalizes the selected definition, records its
digest, and snapshots the workflow, guidance, and payload contracts into the
run. Resume uses that immutable snapshot.

The default graph combines read-only requirements, design, criticism,
adjudication, planning, and alignment nodes with one exclusive writer and a
bounded repair loop. Read nodes may run concurrently up to the configured
limit. Shared command resources serialize, and a writer waits for readers
before running alone. Every provider attempt uses a fresh session and must
return a schema-valid node envelope.

Workflow 2.0 and 2.1 runs may opt into `--context-mode bounded`. This snapshots
a versioned context policy and limits task, node guidance, mapped item, and
predecessor payload and findings data to 128 KiB per provider attempt. An
oversized predecessor becomes a reference only after its exact immutable
attempt artifact is verified. Other required overflow stops before provider
invocation. The default `legacy` mode preserves existing prompts, and the mode
is immutable on resume. Before each bounded provider invocation, the engine
atomically records the complete assembly evidence, context and prompt digests,
and exact byte measurements at
`.pipeline/runs/<run-id>/workflow/context-assemblies/<node-id>/<instance>.loop-<iteration>.attempt-<attempt>.json`.
The record remains available when the provider fails.

The ten-stage v1 engine remains for existing v1 resumes and explicit
`--legacy-linear` runs. Workflow 2.2 is a separate experimental local
wait-and-signal contract; it does not migrate stored 2.0 or 2.1 runs.

## Autonomous CLI

The supported user entry point is the repository umbrella:

```bash
npm run rae -- agent doctor
npm run rae -- agent run \
  --project-root /path/to/target-repository \
  --task "Implement the requested behavior and verify it"
```

Use `npm run rae -- agent --help` for all run, resume, status, stop, signal,
checkpoint, event, provider, workflow, concurrency, and output options.

An ordinary run creates `pipeline/<run-id>` in an isolated worktree under the
target repository's Git metadata at `.git/rae-worktrees/<run-id>`. The final
output identifies that worktree and its
`.pipeline/runs/<run-id>/run-report.md`. `--through plan` stops before a
writer. `--in-place` is explicit and requires a clean target checkout.

RAE exposes no commit, push, publish, deploy, or automatic workflow-activation
action. The `command` provider is an unsandboxed test integration, always
fails `agent doctor`, and requires a fresh unsafe opt-in for every run or
resume.

## Run and registry state

The engine stores each local run under `.pipeline/runs/<run-id>/`, including
the request, immutable workflow snapshot, attempts, artifacts, gates, events,
trace, checkpoints, optional graph projection, and report. State writes are
atomic and lock-protected.

Workflow revisions and activations live under `rae-workflows/v2/` in the
target repository's Git common directory. Cross-run memory lives separately
under `rae-memory/v1/`. Both are owner-controlled; graph memory is advisory
and cannot authorize mutation, change a gate, or replace raw evidence.

## Configuration

- `packages/engine/policies/` contains validated data-only autonomous policy.
- `workflows/` contains committed workflow definitions and recipes.
- execution profile 3.0 maps logical tiers and optional node overrides to named
  Codex or explicit OpenCode routes.
- `--graph-memory off|read|read-write` controls optional graph retrieval and
  is immutable on resume.
- `--context-mode legacy|bounded` controls workflow 2.0 and 2.1 provider
  context; the default is `legacy`.
- `--checkpoint-policy none|before-mutation|before-mutation-and-ship` controls
  human pauses.

Provider selection and credentials do not belong in workflow data. See the
[execution-profile reference](../../docs/reference/contracts/execution-profile-v3.md),
[workflow 2.2 reference](../../docs/reference/contracts/workflow-v2.2.md), and
[graph-memory reference](../../docs/reference/contracts/graph-memory.md).

## Operator and graph consumers

`apps/operator/` uses the public package surface to inspect and control
allowlisted local runs and workflow revisions. The operator remains
loopback-only and does not expose raw provider traces, arbitrary commands,
in-place execution, environment overrides, or publication controls.

The graph CLI builds, checks, queries, and explains local projections:

```bash
npm run rae -- graph build --project-root /path/to/target-repository
npm run rae -- graph query \
  --project-root /path/to/target-repository \
  --seed 'File:src/main.js'
```

Graph loads recheck repository identity, the manifest, current projection
digests, and source freshness for every operation. A small process-local cache
may reuse parsed records and adjacency after those checks; it does not make a
stale projection current.

The experimental `apps/platform/` package also imports `@rae/engine`, but
its `/api/v2` and `/mcp` interfaces are not connected to the operator's
`/api/v1` remote relay.

## Low-level staged interface

The compatibility pipeline interface is available for deterministic contract
work:

```bash
./packages/engine/scripts/pipeline-init.ts
npm run rae -- orchestrate --help
```

Add `--use-worktree` to `pipeline-init.ts` for its separate low-level
worktree lifecycle. This interface can initialize state, run deterministic
stages, record gates and review state, summarize progress, and clean up an
owned worktree. Without an input artifact, the stage runner writes development
fixtures; it is not an autonomous code-writing backend.

## Security boundary

Provider-backed nodes receive the task, node guidance, selected predecessor
context, and output schema. Task files must be relative regular `.md` or
`.txt` files below the canonical project root and are subject to path, size,
encoding, and identity checks. Child environments are allowlisted. Writable
nodes guard `.pipeline` state outside provider-writable roots and verify Git
and ownership postconditions.

Codex routes require the expected workspace sandbox, structured output, event
streaming, and fresh-session capabilities. OpenCode is never selected by
`auto`; write routes require macOS, an isolated worktree, and the
Seatbelt-based containment backend. Provider inference still crosses a network
and data-retention boundary.

See [Security](../../SECURITY.md) for the complete trust model and the
[engine runbook](../../docs/how-to/engine-runbook.md) for recovery.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/cli/` | Autonomous, graph, worker, and staged command entry points |
| `src/run/` | Run lifecycle, state, artifacts, gates, trace, and recovery |
| `src/workflow/` | Contracts, registry, design, scheduling, and transforms |
| `src/agents/` | Provider processes, capability checks, and containment |
| `src/graph/` | Projection, query, and owner-controlled memory |
| `src/primitives/` | Engine-local runtime and path primitives |
| `src/public/` | Sole application import boundary |
| `policies/` | Validated runtime policy data |
| `test/` | The single `node --test` suite, including retained v1 compatibility tests |

Internal imports flow one way: `cli/` depends on `run/` and `workflow/`
(which may import each other); those depend on `agents/` and `graph/`; and all
of them depend on `primitives/`. `public/` may import anything. This ordering
is mechanically enforced by `scripts/dist/check-architecture.js`, which every
`npm run verify` invocation runs.

The complete dependency and state model is in
[Architecture](../../docs/ARCHITECTURE.md). Operator HTTP behavior is in the
[operator guide](../../apps/operator/README.md).

## Limitations

- Isolated runs require a committed Git repository with usable `HEAD` and
  current-branch reflogs.
- The operator cannot prove termination of a descendant that creates a new
  POSIX session.
- Runtime-state recovery fails closed while process ownership or repository
  identity is uncertain.
- OpenCode writes are supported only on the documented macOS boundary.
- Deterministic fixtures do not prove behavior for arbitrary repositories,
  providers, accounts, or hosted deployments.

The package is covered by the repository [MIT License](../../LICENSE).
