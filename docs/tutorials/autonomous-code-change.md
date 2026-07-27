---
status: stable
owner: orchestration
last_reviewed: 2026-07-19
source_of_truth: packages/orchestration/scripts/pipeline/autonomous.mjs
evidence_links: ../reference/cli/umbrella.md
---

# First Autonomous Code Change

This tutorial runs RAE as a real coding-agent orchestrator. The workflow plans,
writes code and tests, checks documentation, validates structured artifacts,
and leaves a reviewable change in an isolated Git worktree.

## Prerequisites

- the target is a Git repository with at least one commit and enabled
  HEAD/current-branch reflogs
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`, plus the
  repository's normal verification tools
- Codex CLI is installed and authenticated
- RAE's orchestration dependencies were prepared with `./scripts/verify.sh`

Check the agent-specific runtime contract:

```bash
./scripts/rae.sh agent doctor
```

The command must report authentication, workspace sandboxing, structured
output, JSON event streaming, and ephemeral phase sessions. The broader
`./scripts/rae.sh doctor` intentionally does not require a model runner because
deterministic tools and benchmarks can run without one.

## Run one task

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repo \
  --checkpoint-policy before-mutation-and-ship \
  --task "Add a tested health endpoint and document its response contract"
```

RAE creates a `pipeline/<run-id>` branch in a worktree under the target's Git
metadata directory (`.git/rae-worktrees/<run-id>`) by default. The target's
tracked checkout and `git status` remain unchanged, and dirty uncommitted
changes are not copied into the new worktree. Use `--in-place` only when you
deliberately want to modify a clean target checkout.

## Follow the result

The command prints:

- `run_id`
- `workspace`
- changed-file count
- `.pipeline/runs/<run-id>/run-report.md`

Inspect the implementation and evidence:

```bash
git -C "/path/from/the-workspace-output" diff
sed -n '1,240p' "/path/from-the-report-output"
```

The run report links the ten phase gates, actual changed files, documentation
status, and residual release conditions. The plan must explicitly decide
whether documentation is required and name its owned paths; a required path
that does not change blocks the build gate. RAE exposes no commit, push,
publish, or deploy action, and supported Codex runs reject protected Git-state
changes after every phase. A completed run therefore ends in
`implemented-awaiting-human-release-review`.

![Deterministic output from `rae.sh agent --help` showing the isolated-worktree
default, sandbox modes, prohibited actions, and command-provider opt-in.](../assets/screenshots/rae-agent-safety.svg)

Provider-backed Codex runs also write a redacted JSONL event log for each phase
under `agent-outputs/`. Build and quality phases must contain captured
`command_execution` evidence; a model-only assertion without a command event
cannot pass those gates.

For a visual view of the same durable run state, start the local console in a
second terminal:

```bash
./scripts/rae.sh operator serve --project /path/to/target-repo
```

Open the printed loopback URL. The session token stays in browser memory, and
the console receives only projected operator events rather than raw provider
traces. A checkpoint approval requires a rationale; reject and escalate are
terminal for that checkpoint. Stop is applied at a phase boundary. Interrupt is
available only for the exact process started by that console and records a
durable interrupted state before resume. Its response also reports
`containment_uncertain`: a POSIX process group cannot prove that a deliberately
detached descendant stopped, so inspect provider activity and the worktree
before resuming.

## Plan without changing code

```bash
./scripts/rae.sh agent run \
  --project-root /path/to/target-repo \
  --through plan \
  --task "Describe and plan the requested migration"
```

Every phase through `plan` uses a read-only agent sandbox. Resume later from
the workspace printed by the command:

```bash
./scripts/rae.sh agent resume \
  --project-root /path/from/the-workspace-output \
  --run-id <run-id>
```

## Failure behavior

The workflow stops when a schema, traceability check, plan ownership rule,
test, documentation audit, security audit, or release condition fails. It keeps
the worktree and writes a blocked run report so the failure can be inspected or
resumed. In particular, a builder changing a file absent from
`plan.file_ownership` cannot pass the build gate.

Only one autonomous process may own a run at a time. A concurrent `resume`
fails against `.pipeline/runs/<run-id>/autonomous.lock`. After a host crash,
resume reconciles the external `.pipeline` byte guard before reading run state
and removes only the stale lock associated with that recovered run. If the
guard owner may still be active, repository identity changed, or restoration
cannot be verified, resume fails closed. Do not delete guard state to bypass
that result.

## Interpretation limits

- a passing local run is evidence about the executed task and checks, not proof
  of universal agent reliability
- unavailable project tools remain explicit verification gaps
- the custom command-provider protocol is a test/integration surface, always
  fails `agent doctor`, receives a sanitized environment, and cannot run unless
  its operator explicitly passes `--allow-unsafe-command-provider`; resume must
  repeat the provider, command, at least one argument, and unsafe flag; it does
  not supply filesystem, network, or adversarial Git-metadata sandbox guarantees

## Source note

- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
