<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/rae-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/rae-lockup-light.svg">
    <img alt="RAE: Reliable Agentic Engineering" src="docs/assets/brand/rae-lockup-light.svg" width="820">
  </picture>
</p>

[![ci](https://github.com/sebastianspicker/rae/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sebastianspicker/rae/actions/workflows/ci.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/138a23bb9a53432d899877961b8d2ab2)](https://app.codacy.com/gh/sebastianspicker/rae/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13179/badge)](https://www.bestpractices.dev/projects/13179)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sebastianspicker/rae/badge)](https://scorecard.dev/viewer/?uri=github.com/sebastianspicker/rae)
[![License: MIT](https://img.shields.io/github/license/sebastianspicker/rae)](LICENSE)

RAE is a source-distributed toolkit for controlled repository changes. It
combines graph workflows, isolated Git worktrees, schema-validated artifacts,
human checkpoints, verification gates, and local run evidence.

The repository is an alpha candidate. It does not publish a package, container,
hosted service, or stable API. An experimental hosted-platform source slice is
present and the local operator can proxy allowlisted run routes in remote mode;
it is not wired into the umbrella CLI. See [Release
Status](RELEASE_STATUS.md) for the current release evidence.

## Capabilities and limitations

RAE currently provides:

- a graph-native orchestration runtime with typed nodes, joins, bounded repair loops, and immutable evidence envelopes
- isolated Git worktrees for autonomous repository changes
- a loopback-only operator console with synchronized Loop, Graph, Analyze, and JSON workflow views
- explicit Codex and OpenCode execution routes through operator-owned profiles
- Ralph audit, linting, and story-scoped fixing modes
- benchmark validation, execution, comparison, calibration, and release gates
- opt-in local repository, workflow, evidence, and temporal-memory graph projections
- an experimental hosted control-plane and self-hosted worker source slice
- a transactional Git co-author trailer cleaner
- sanitized environment-profile templates and installers

The following limits are part of the current implementation:

- Codex remains the default autonomous executor; OpenCode must be selected
  explicitly and is never selected by `auto`
- OpenCode mutation is supported only on macOS, in an isolated RAE worktree,
  under the system `sandbox-exec` boundary; OpenCode rejects `--in-place`
- OpenRouter models are supported only through OpenCode configuration; RAE does
  not call the OpenRouter API directly
- the custom command provider is an unsandboxed test surface and always fails
  `agent doctor`
- RAE does not commit, push, publish, or deploy target-repository changes
- isolated worktree runs require a committed Git repository with usable
  `HEAD` and current-branch reflogs
- Ralph fixing transactions support macOS and Linux; unsupported platforms
  fail closed
- evaluation results apply only to the recorded benchmark, configuration, and
  environment

## Requirements

- GNU Bash 5.3 or newer
- Python 3.14.6 or newer
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`
- npm
- `git`, `jq`, `rg`, and `shellcheck`
- Python dependencies from `requirements-ci.txt` or
  `requirements-macos.txt`
- Codex CLI for Codex-backed autonomous runs and Ralph
- OpenCode CLI only for explicitly selected OpenCode autonomous routes on
  macOS
- `git-filter-repo` only for the co-author trailer cleaner

`./scripts/rae.sh doctor` checks the required runtime versions and executable
entrypoints. It reports optional tools separately.

## Installation

Create a virtual environment and install the pinned Python verification
dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements-ci.txt
npm --prefix packages/orchestration ci
./scripts/rae.sh doctor
```

On macOS with Python 3.14, install `requirements-macos.txt` instead. That lock
selects the pinned Watchdog source archive and requires the Xcode command-line
tools.

This setup prepares a source checkout. There is no separate installation
artifact.

## Configuration

The umbrella command forwards arguments to the runtime that owns them:

| Surface | Configuration source |
| --- | --- |
| Autonomous runs and operator console | [`packages/orchestration/README.md`](packages/orchestration/README.md) |
| Ralph | [`packages/loops/ralph/README.md`](packages/loops/ralph/README.md) |
| Evaluation | [`docs/reference/cli/umbrella.md`](docs/reference/cli/umbrella.md) |
| Co-author trailer cleaner | [`tools/repo-hygiene/coauthor-trailer-cleaner/README.md`](tools/repo-hygiene/coauthor-trailer-cleaner/README.md) |
| Environment profiles | [`profiles/agent-environments/README.md`](profiles/agent-environments/README.md) |

Use `--policy <path>` to select a validated orchestration policy. Use
`--checkpoint-policy before-mutation` or
`before-mutation-and-ship` to require operator approval at those boundaries.
Use `--graph-memory read` or `read-write` only when local graph retrieval is
required. Graph memory is `off` by default.
Ralph accepts command flags and `RALPH_*` environment variables documented in
its package README.

Do not place credentials, tokens, keys, or unrelated private material in task
text, task files, policy files, or predecessor artifacts. Provider-backed
commands transmit the task and selected execution context to the configured
provider.

## Usage

List the command families:

```bash
./scripts/rae.sh --help
```

Check the autonomous runtime:

```bash
./scripts/rae.sh agent doctor
```

Run a task in an isolated worktree:

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repository \
  --task "Add a tested health endpoint and document its behavior"
```

New runs use the committed graph-native workflow by default. Select a validated
workflow with `--workflow`, stop at a node with `--through`, or temporarily
start the v1 engine with `--legacy-linear`. Existing v1 requests always resume
through the linear engine.

Inspect future workflow revisions with `graph workflow list|validate|show|diff`
and activate a reviewed revision with `graph workflow activate`. Activation
requires an attributed rationale and exact digest confirmation, and affects
future runs only.

Workflow schema 2.1 supports bounded data-driven fan-out, item streams,
deterministic transforms, threshold joins, until-dry discovery, and logical
execution tiers. Execution profile 3.0 maps those tiers and optional node
overrides to explicit Codex or OpenCode routes. Use `graph workflow analyze`
for static topology and bound diagnostics. Use `graph workflow propose
--preview` for a validated, unsaved candidate. Proposals, saved revisions, and
exact-digest activation remain separate operations.

The operator console presents the same workflow as four synchronized views.
Its guided editor targets workflow 2.1. Existing workflow 2.0 and experimental
2.2 revisions remain available through the JSON view. See [Graph Engineering
with RAE](docs/tutorials/graph-engineering-with-rae.md) and [Execution
Profile 3.0](docs/reference/contracts/execution-profile-v3.md).

Workflow 2.2 is an experimental local wait-and-signal contract. It adds typed
wait signals and bounded context manifests without changing existing 2.0 or 2.1
runs. See [Workflow 2.2 Contract](docs/reference/contracts/workflow-v2.2.md).

Use `--through plan` to stop before repository mutation. The default worktree
is stored under the target repository's Git metadata at
`.git/rae-worktrees/<run-id>`. The final output identifies the worktree and
`.pipeline/runs/<run-id>/run-report.md`.

Serve the local operator console for explicitly allowlisted repositories:

```bash
./scripts/rae.sh operator serve \
  --project /canonical/path/to/target-repository \
  --execution-profile /absolute/path/to/execution-profile.json
```

Run Ralph health checks or an audit:

```bash
./scripts/rae.sh ralph --check
./scripts/rae.sh ralph --mode audit 10
```

Ralph requires a local `prd.json`. Follow the
[Ralph setup](packages/loops/ralph/README.md#setup) before the first run.

Route one task specification:

```bash
./scripts/rae.sh task route \
  --task-spec evals/datasets/tool-selection/tool-selection-core.task-specs.json \
  --task-id tool-selection-dev-orchestration \
  --output evals/results/local/planned-route.json
```

Run one benchmark split:

```bash
./scripts/rae.sh eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split dev \
  --output-dir evals/results/local-dev
```

Evaluate a sealed workflow-improvement campaign without activation:

```bash
./scripts/rae.sh eval improve \
  --campaign evals/campaigns/autonomous-policy-improvement.v2.json \
  --baseline-evaluation evals/results/local/baseline-development.json \
  --candidate-policy evals/results/local/candidate-policy.json \
  --candidate-evaluation evals/results/local/candidate-development.json \
  --sealed-evaluation evals/results/local/candidate-held-out.json \
  --output-dir evals/results/local/improvement-campaign
```

Local outputs under `evals/results/local*`, `.pipeline/`, and package runtime
directories are intentionally ignored.

## Repository structure

| Path | Responsibility |
| --- | --- |
| `scripts/` | Umbrella CLI, verification, screenshot checks, and repository validators |
| `packages/orchestration/` | Staged runtime, operator console, policies, contracts, and tests |
| `packages/loops/ralph/` | Audit, linting, and transactional fixing loop |
| `tools/repo-hygiene/` | Narrow repository-maintenance utilities |
| `evals/` | Benchmark cards, task specifications, schemas, fixtures, and committed baselines |
| `profiles/agent-environments/` | Sanitized profile templates and installer tests |
| `docs/` | Tutorials, how-to guides, reference, explanation, research, and governance |
| `examples/` | Minimal runnable layouts and command examples |
| `tests/` | Umbrella runtime and repository-contract tests |

See the [repository map](docs/reference/repo-map.md) for ownership details.

## Development workflow

1. Read `AGENTS.md`, this README, `CONTRIBUTING.md`, and the nearest
   package documentation.
2. Make changes in the package that owns the behavior.
3. Run the narrow package test or validator while iterating.
4. Run the repository verifier before requesting review.
5. Inspect `git diff --check` and the complete diff.

Synchronized orchestration adapters are derived from
`packages/orchestration/adapters/templates/`. Regenerate and check them with:

```bash
python3 packages/orchestration/scripts/adapters/generate_adapters.py
python3 packages/orchestration/scripts/adapters/generate_adapters.py --check
```

## Testing

The complete suite layout and focused commands are documented in
[TESTING.md](TESTING.md).

The documented repository gate is:

```bash
./scripts/verify.sh --skip-install
```

Run `./scripts/verify.sh` to install declared dependencies before verification.
Use `--skip-mkdocs` only when the pinned documentation toolchain is unavailable;
that mode is partial and is not release evidence.

Package-level commands:

```bash
npm --prefix packages/orchestration run test:operator
npm --prefix packages/orchestration run test:runner
bash packages/loops/ralph/scripts/run_tests.sh
bash tools/repo-hygiene/coauthor-trailer-cleaner/tests/run-tests.sh
```

The umbrella verifier runs repository validation, Python linting and type
checks, Python tests, shell checks, package tests, benchmark checks, profile
installer tests, screenshot validation, and documentation checks.

## Operation and release

RAE operates from a source checkout. Runtime state remains local to the
checkout, isolated worktree, or the package-specific private state directory.
The operator console binds to loopback and requires an ephemeral bearer token.

Release candidates follow [RELEASING.md](RELEASING.md). The complete release
gate is:

```bash
./scripts/verify.sh --release-candidate
```

A release consists of a reviewed source tag and optional source archive. The
repository contains no production application deployment configuration. The
experimental local development compose file is not a deployment artifact.

## Troubleshooting

- `rae.sh doctor` reports the installed version and path for each required
  command. Install the missing command or select Python with `PYTHON_BIN`.
- `agent doctor` without provider options checks Codex. For OpenCode, pass
  `--provider opencode --model <provider/model>`; the diagnostic also verifies
  the macOS sandbox and effective denied-by-default tool configuration.
- A failed autonomous phase names its gate and run report. Correct the reported
  dependency or target issue, then use `agent resume` with the printed run ID
  and worktree path.
- A stale Ralph lock without a valid process ID becomes recoverable after
  `RALPH_STALE_LOCK_NO_PID_SECONDS`, which defaults to 30 seconds.
- A strict report-path error means the story's `Created <path>.md` criterion
  does not resolve under the configured `defaults.report_dir`.
- Documentation link or metadata failures can be checked with
  `python3 -B scripts/verify_repo.py --skip-mkdocs`.

Package-specific recovery procedures are in the
[orchestration runbook](packages/orchestration/docs/RUNBOOK.md) and
[Ralph README](packages/loops/ralph/README.md).

## Security considerations

- Treat provider-backed execution as a data-transfer boundary.
- Keep autonomous work in the default isolated worktree unless a clean,
  in-place run is required.
- Do not enable the custom command provider outside controlled tests.
- Review all diffs and run reports before making any Git or publication change.
- Keep local state, benchmark outputs, credentials, and private overlays
  untracked.
- Back up repositories before using the history-rewrite utility.

See [SECURITY.md](SECURITY.md) for reporting, supported scope, and runtime
boundaries.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, documentation rules, checks,
and review expectations. Use [SUPPORT.md](SUPPORT.md) for usage questions and
the private route in [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

[MIT](LICENSE)
