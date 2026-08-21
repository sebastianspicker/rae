# Phased orchestration

This package implements RAE's graph-native repository workflow, autonomous executor,
operator console, artifact contracts, policy validation, and deterministic
gates.

## Execution model

New autonomous runs resolve a workflow in this order: explicit `--workflow`,
the locally activated workflow, then the committed
`workflows/graph-native-default.workflow.json`. The resolved workflow, node
guidance, payload contracts, and canonical digest are copied into the run and
remain immutable on resume.

The default graph includes requirements and design agents, four parallel design
critics, deterministic collection and adjudication, planning, two alignment
extractors, one exclusive build writer, and a five-round repair loop. Read-only
nodes run up to four-wide. Shared command resources serialize, and a writer
drains readers before running alone. Every attempt uses a fresh provider session
and an immutable result envelope.

The ten ordered stages below are the v1 compatibility engine. Use
`--legacy-linear` only for a temporary new v1 run. Existing v1 request files
select it automatically on resume.

The runtime uses ten ordered stages:

| Stage | Responsibility | Primary artifact |
| --- | --- | --- |
| `arm` | Convert task input into explicit requirements | `brief.json` |
| `design` | Define an implementation design from validated constraints | `design.json` |
| `adversarial-review` | Record independent design findings | `review.json` |
| `plan` | Define tasks, ownership, and verification | `plan.json` |
| `pmatch` | Check intent alignment across the brief, design, and plan | `drift-reports/pmatch.json` |
| `build` | Apply plan-owned repository changes | `build.json` |
| `quality-static` | Run declared lint, format, and type checks | `quality-reports/static.json` |
| `quality-tests` | Run declared tests | `quality-reports/tests.json` |
| `post-build` | Aggregate documentation, security, and cleanup checks | gate only |
| `release-readiness` | Record release conditions and approvals | `release-readiness.json` |

Every stage writes a corresponding JSON gate under
`.pipeline/runs/<run-id>/gates/`. A failed gate stops progression. The runtime
also writes trace events, review state, progress summaries, and a final run
report.

## Requirements

- GNU Bash 5.3 or newer
- Python 3.14.6 or newer
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`
- npm
- `git` and `rg`
- Codex CLI for Codex-backed autonomous runs
- OpenCode CLI for explicit OpenCode routes on the supported macOS containment
  backend
- a target Git repository with at least one commit and usable `HEAD` and
  current-branch reflogs

Install package dependencies from the repository root:

```bash
npm --prefix packages/orchestration ci
```

From this package directory, run:

```bash
npm ci
./scripts/verify.sh
```

## Autonomous runs

Check the provider boundary:

```bash
npm run agent -- doctor
```

Run a task:

```bash
npm run agent -- run \
  --project-root /path/to/target-repository \
  --task "Implement the requested behavior, add tests, and update the documentation"
```

The default run creates `pipeline/<run-id>` in an isolated worktree under the
target repository's Git metadata at `.git/rae-worktrees/<run-id>`. Each stage
uses a fresh provider session, validates its JSON output, and advances only
after the owning gate passes. Build and quality stages require captured command
execution. The runtime checks `plan.file_ownership` against the final diff.

RAE does not expose commit, push, publish, or deploy actions. The final release
decision remains conditional on human inspection of the worktree, run report,
and verification evidence.

Useful options:

- `--workflow <path>` selects a validated graph-native workflow for a new run
- `--execution-profile <path>` snapshots an operator-owned mapping from logical
  economy, standard, and judgment tiers to named Codex or OpenCode routes; it is
  mutually exclusive with global provider, model, reasoning, and variant
  overrides
- `--through <node-id>` stops after the selected workflow node
- `--max-concurrency <1..4>` caps concurrent read-only nodes
- `--max-repair-rounds <1..5>` tightens the workflow repair bound
- `--legacy-linear` starts the v1 ten-stage engine
- `--checkpoint-policy before-mutation` pauses before the first writable stage
- `--checkpoint-policy before-mutation-and-ship` also pauses before the final
  release decision
- `--policy <path>` selects a validated data-only phase policy
- `--task-file <relative-path>` reads a regular `.md` or `.txt` file below the
  target root
- `--in-place` uses an explicitly clean target checkout instead of an isolated
  worktree
- `--json` emits machine-readable command output
- `--graph-memory off|read|read-write` controls opt-in local graph retrieval;
  the default is `off` and the selected mode is immutable on resume

Run `npm run agent -- --help` for the complete option reference.

Resume a stopped run from the worktree path printed by the original command:

```bash
npm run agent -- resume \
  --project-root /path/from/the/run-output \
  --run-id <run-id>
```

Resume restores the recorded model, reasoning effort, timeout, policy, and
checkpoint settings unless they are explicitly overridden.

The `command` provider exists for controlled tests and integration development.
It has no filesystem or network sandbox, always fails `agent doctor`, and
requires `--allow-unsafe-command-provider` on every run and resume. Do not use
it as an operational backend.

## Operator console and workflow designer

From the repository root:

```bash
./scripts/rae.sh operator serve \
  --project /canonical/path/to/target-repository
```

Repeat `--project` to allowlist more than one Git root. The console binds only
to loopback and prints a URL with an ephemeral bearer token in the fragment.
Repeat `--execution-profile` to preload server-owned profile files. The browser
receives only profile IDs, route metadata, models, and readiness. It never
receives profile paths, credentials, environment values, or raw provider
events.
It exposes status, projected events, stop, interrupt, resume, checkpoint, and
fail-closed cleanup controls. It does not expose in-place execution, arbitrary
commands, environment overrides, Git publication, or deployment.

The workflow workspace keeps Loop, Graph, Analyze, and JSON views synchronized.
Five guided templates compile directly to workflow 2.1. Structured node and
edge controls remain keyboard operable, while the JSON view retains access to
existing 2.0 and experimental 2.2 revisions. Analysis and proposal results stay
unsaved until an operator creates a revision. Activation remains a separate,
exact-digest action.

See [`operator/README.md`](operator/README.md) for the HTTP and event contract.

## Local graph projections

Use the umbrella `graph` command to build, inspect, query, explain, or manage
local graph memory:

```bash
./scripts/rae.sh graph build --project-root /path/to/target-repository
./scripts/rae.sh graph query --project-root /path/to/target-repository \
  --seed 'File:src/main.js'
```

Run projections remain under `.pipeline/runs/<run-id>/graph/`. Cross-run
memory remains owner-only under the target repository's Git common directory
at `rae-memory/v1/`. The graph augments context and explanation only. Raw
artifacts, traces, gates, checkpoints, policies, Git state, and human release
decisions remain authoritative.

Workflow drafts and activation records live under the target Git common
directory at `rae-workflows/v2/`. The owner-only registry uses atomic writes,
an exclusive lock, optimistic revisions, canonical digests, and attributed
activation decisions. The operator editor uses the same registry and rejects
changes while a run is active.

Workflow schema 2.1 adds bounded map and stream instances, deterministic
transforms, first-success and quorum joins, typed failure collection,
until-dry convergence, and logical execution tiers. Stored 2.0 runs and active
2.0 registry revisions keep their original executor. RAE does not migrate a
private registry automatically.

Workflow 2.2 is an experimental local scheduler for durable wait nodes and
typed signals. It writes wait state under
`.pipeline/runs/<run-id>/workflow/wait-state.json`, consumes accepted signals
idempotently on resume, and fails a wait on timeout. Its bounded context
assembly is not a context-efficiency result. Existing 2.0 and 2.1 runs remain
on their original schedulers. See
[`docs/reference/contracts/workflow-v2.2.md`](../../docs/reference/contracts/workflow-v2.2.md).

Create a proposal with:

```bash
./scripts/rae.sh graph workflow propose \
  --project-root /path/to/target-repository \
  --task "Design a bounded topology" \
  --base-workflow graph-native-default \
  --actor "operator-name" \
  --rationale "Draft for review"
```

Without `--preview`, the command stores a validated draft revision. Add
`--preview` to return a validated candidate without saving it. When an
execution profile is supplied, proposal generation uses its `judgment` route.
Neither mode activates or executes the result.

## Low-level pipeline API

Create local pipeline state:

```bash
./scripts/pipeline-init.sh
```

Create an isolated pipeline worktree:

```bash
./scripts/pipeline-init.sh . --use-worktree
```

Run one deterministic stage:

```bash
node scripts/pipeline/runner.mjs run-stage \
  --run-id <run-id> \
  --phase arm \
  --config-id phased_default
```

Without `--input-artifact`, `run-stage` writes deterministic development
artifacts. It does not modify application code.

Other low-level operations include artifact and gate recording, review-state
updates, run summaries, progress summaries, and diagnostics:

```bash
node scripts/pipeline/runner.mjs --help
```

Pipeline configuration IDs are defined by the runner:

| ID | Behavior |
| --- | --- |
| `phased_default` | Standard ten-stage pipeline |
| `baseline_single_agent` | Single-session comparison baseline |
| `phased_with_context_budgets` | Per-stage token and file budgets |
| `phased_dual_extractor_drift` | Dual extraction for `pmatch` |

## Policies and adapters

Runtime policies are JSON data under `policies/`. The autonomous runner
validates a selected policy, records its digest and snapshot, and rejects
resume-time drift.

Runner guidance under `adapters/<runner>/skills/` is derived from
`adapters/templates/` and the manifest at
`adapters/spec/adapter-manifest.json`. Regenerate it with:

```bash
python3 scripts/adapters/generate_adapters.py
python3 scripts/adapters/generate_adapters.py --check
```

Committed guidance adapters exist for Codex, Cursor, Claude, Gemini, and Kilo.
The autonomous runtime has executable adapters for Codex and explicit OpenCode
routes. The other adapters are portable guidance and must not be interpreted
as executable integrations.

## Repository structure

| Path | Responsibility |
| --- | --- |
| `scripts/pipeline/` | Autonomous and low-level pipeline CLIs |
| `operator/` | Loopback console and tests |
| `contracts/` | JSON schemas for artifacts and gates |
| `policies/` | Validated phase policy data |
| `adapters/templates/` | Source templates for runner guidance |
| `adapters/<runner>/` | Synchronized runner-specific guidance |
| `orchestrators/` | Stage instructions consumed by the runtime |
| `skills/dev-tools/` | Quality-gate, review, and trace packages |
| `docs/` | Package runbook, platform notes, policy, and repository map |
| `platform/` | Experimental PostgreSQL control plane, OIDC API, fenced worker lease, artifact, and MCP source |

## Security and data handling

Provider-backed stages receive the task, stage objective, selected policy
guidance, and selected predecessor artifacts. Do not include secrets or
unrelated private content in those inputs.

The runner:

- removes ambient environment variables outside a fixed allowlist
- accepts task files only as relative, regular, non-symlink `.md` or `.txt`
  files below the canonical target root
- rejects credential-like task-file paths, traversal, invalid UTF-8, empty
  files, and files larger than 128 KiB
- redacts absolute path tokens from task and artifact text before provider
  submission
- records redacted provider events under the run directory
- guards `.pipeline` state outside provider-writable workspace and temporary
  roots during writable stages
- rejects protected Git-state changes on supported provider runs

OpenCode write routes add a macOS Seatbelt boundary around the isolated
worktree. RAE verifies the effective OpenCode configuration before execution,
denies shell, web, external-directory, plugin, skill, subagent, question, and
unapproved MCP access, and exposes only an opaque allowlisted verification
broker. The pinned OpenCode process can read its configured credential store;
credential contents are not copied into run artifacts or operator responses.

The provider process still receives the working directory and schema paths
needed for execution. Consult the provider's data controls for storage and
retention behavior.

See the repository [security policy](../../SECURITY.md).

## Development and testing

Run the package verifier:

```bash
./scripts/verify.sh
```

For changed packages only:

```bash
./scripts/verify.sh --changed-only
```

Run the deterministic workflow-topology fixture separately when scheduler
ordering changes:


It reports fixture event order, critical path, and barrier idle time. It makes
no model-quality or universal speed claim.

The package verifier checks adapters, schemas, stale references, Markdown
links, repository hygiene, TypeScript builds, Biome, and the compact runner and
operator boundary suites. The root repository gate remains:

```bash
../../scripts/verify.sh --skip-install
```

Operational recovery and troubleshooting are documented in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). Platform support is documented in
[`docs/PLATFORMS.md`](docs/PLATFORMS.md).

The `platform/` package is an experimental vertical slice connected to the
operator only through remote-mode proxy routes. Its source-unit test can be
run with `npm --prefix platform test` from this directory. PostgreSQL,
container, OIDC, S3-compatible storage, and remote worker execution remain
integration evidence lanes.

## Limitations

- Worktree isolation depends on Git reflogs and repository identity checks.
- The operator console cannot prove termination of a child that deliberately
  creates a new POSIX session.
- Guard recovery fails closed while ownership or repository identity is
  uncertain.
- OpenCode write routes are supported only on macOS, require the isolated
  worktree, and reject `--in-place`.
- A real provider run is still required before treating fake-executable event
  tests as evidence for a specific OpenCode release or provider account.
- Deterministic fixtures and committed baselines are test evidence, not proof
  of behavior on arbitrary repositories.
- The low-level stage runner validates pipeline contracts; it is not a
  code-writing backend.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the repository
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## License

[MIT](../../LICENSE)
