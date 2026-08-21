---
status: stable
owner: core
last_reviewed: 2026-08-04
source_of_truth: scripts/rae.sh
evidence_links: ../claims/evidence-index.md
---

# Umbrella CLI

`./scripts/rae.sh` is the repository entrypoint. It validates the runtime
before dispatching to the package that owns each command.

## Command ownership

| Command | Owner | Purpose |
| --- | --- | --- |
| `verify` | `scripts/verify.sh` | Run repository verification |
| `doctor` | `scripts/rae.sh` | Check runtime versions, tools, and entrypoints |
| `agent` | orchestration autonomous CLI | Run, inspect, stop, or resume an autonomous workflow |
| `graph` | orchestration graph CLI | Build and query local projections or manage cross-run memory |
| `operator serve` | orchestration operator console | Serve the loopback console for allowlisted repositories |
| `orchestrate` | orchestration stage runner | Manage pipeline stages, artifacts, gates, and summaries |
| `worktree` | orchestration worktree CLI | Create, inspect, resume, or clean isolated runs |
| `ralph` | Ralph package | Run audit, linting, or story-scoped fixing |
| `hygiene` | repository hygiene tools | Run an explicitly selected maintenance utility |
| `workflow` | umbrella aliases | Use task-oriented aliases for the same package commands |

Run:

```bash
./scripts/rae.sh --help
```

Subcommand options are owned by the selected runtime:

```bash
./scripts/rae.sh agent --help
./scripts/rae.sh graph --help
./scripts/rae.sh orchestrate --help
./scripts/rae.sh ralph --help
```

## Diagnostics

```bash
./scripts/rae.sh doctor
```

The command enforces:

- GNU Bash 5.3 or newer
- Python 3.14.6 or newer
- a supported Node.js version
- `git`, `rg`, `jq`, and `shellcheck`
- runnable package entrypoints

Optional documentation and maintenance tools are reported without failing the
core diagnostic.

Provider-backed autonomous work has a separate diagnostic:

```bash
./scripts/rae.sh agent doctor
```

Without provider options, the command checks Codex authentication, workspace
sandboxing, JSON-schema output, event streaming, and ephemeral sessions. Use
`agent doctor --provider opencode --model <provider/model>` to check the exact
OpenCode binary, merged permission configuration, credential-store presence,
and macOS containment backend.

## Autonomous run

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --task "Implement the change, add regression tests, and update the documentation"
```

The default run creates `pipeline/<run-id>` under
`.git/rae-worktrees/<run-id>`. It prints the worktree and run-report paths.
Use `--through plan` to stop before mutation and `--checkpoint-policy` to add
operator decisions at protected boundaries.

Resume after correcting an environmental failure:

```bash
./scripts/rae.sh agent resume \
  --project-root /path/from/the-run-output \
  --run-id <run-id>
```

RAE does not expose commit, push, publish, or deploy actions. Supported runs
reject protected Git-state changes.

Graph retrieval is disabled by default. Enable current, trusted local retrieval
for one run with `--graph-memory read`, or admit verified outcomes and
quarantine model-proposed candidates with `--graph-memory read-write`. The mode
is immutable on resume.

Use an operator-owned execution profile when workflow nodes declare logical
tiers:

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --execution-profile /absolute/path/to/execution-profile.json \
  --task "Implement and verify the requested change"
```

`--execution-profile` is mutually exclusive with `--provider`, `--model`,
`--reasoning-effort`, and `--variant`. Execution profile 3.0 resolves logical
tiers and optional per-node overrides to named Codex or OpenCode routes. The
validated profile, canonical digest, resolved node routes, models, and exact
executor versions are stored in the run request and remain immutable on
resume.

OpenCode is explicit:

```bash
./scripts/rae.sh agent doctor \
  --provider opencode \
  --model opencode/example-model

./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --provider opencode \
  --model openrouter/example-model \
  --task "Implement and verify the requested change"
```

OpenCode writes require the isolated macOS worktree backend and reject
`--in-place`. `auto` never selects OpenCode.

## Local graph and memory

```bash
./scripts/rae.sh graph build --project-root /path/to/target-repository
./scripts/rae.sh graph status --project-root /path/to/target-repository
./scripts/rae.sh graph query --project-root /path/to/target-repository \
  --seed 'File:src/main.js'
```

The graph is local, rebuildable, and advisory. It cannot modify gates,
checkpoints, policies, evaluators, Git state, publication state, or plan
ownership. See the [graph and memory contract](../contracts/graph-memory.md).

Workflow revisions use the same graph command family:

```bash
./scripts/rae.sh graph workflow list --project-root /path/to/target-repository
./scripts/rae.sh graph workflow validate --project-root /path/to/target-repository \
  --workflow-file /absolute/path/to/workflow.json
./scripts/rae.sh graph workflow analyze \
  --workflow-file /absolute/path/to/workflow.json \
  --execution-profile /absolute/path/to/execution-profile.json
./scripts/rae.sh graph workflow propose --project-root /path/to/target-repository \
  --task "Design a bounded topology" --base-workflow graph-native-default \
  --actor "operator-name" --rationale "Draft for review" \
  --execution-profile /absolute/path/to/execution-profile.json --preview
```

`analyze` reports schema and topology errors, unreachable nodes, writer and
verification paths, bounded attempts and instances, concurrency, and resolved
routes. It reports monetary cost as unavailable when provider usage data is not
present.

`propose` starts one read-only, ephemeral structured-output session and permits
one correction after local validation. `--preview` returns a validated candidate
without saving it; omitting `--preview` stores a valid attributed draft. An
execution profile supplies the `judgment` route. Neither mode activates or
executes the result.

## Operator console

```bash
./scripts/rae.sh operator serve \
  --project /canonical/path/to/target-repository \
  --execution-profile /absolute/path/to/execution-profile.json
```

Repeat `--project` for additional allowlisted roots. The server binds to
loopback and prints an ephemeral token in the URL fragment. The console starts
only isolated-worktree runs and does not expose arbitrary commands, environment
overrides, in-place execution, Git publication, or deployment.

## Workflow aliases

- `workflow autonomous` forwards to `agent`
- `workflow repo-audit` forwards common audit operations to Ralph
- `workflow long-horizon` forwards to staged orchestration
- `workflow hygiene` forwards to repository hygiene tools

Aliases do not define independent behavior. The package command remains the
source of truth.

## Exit behavior

`rae.sh` rejects unknown command families and propagates the selected runtime's
exit status. A command that cannot establish its required safety boundary fails
closed.

## Related documentation

- [Orchestration CLI](orchestration.md)
- [Ralph CLI](ralph.md)
- [Repository hygiene CLI](repo-hygiene.md)
- [Orchestration package](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/README.md)
- [Ralph package](https://github.com/sebastianspicker/rae/blob/main/packages/loops/ralph/README.md)

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
