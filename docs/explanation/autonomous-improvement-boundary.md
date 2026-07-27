---
status: experimental
owner: orchestration
last_reviewed: 2026-07-19
source_of_truth: packages/orchestration/scripts/pipeline/autonomous.mjs
evidence_links: ../how-to/run-a-benchmark.md
---

# Autonomous Improvement Boundary

RAE now has a bounded improvement loop, not a recursively self-modifying
runtime. Provider-backed execution, evaluation, policy experiments, and human
promotion are deliberately separate trust domains:

| Domain | May change | May not change |
|---|---|---|
| Autonomous runtime | Files explicitly owned by an approved run plan | Git history, remotes, evaluator code, runtime defaults |
| Outcome evaluator | Experimental result artifacts under `evals/results/` | Candidate worktrees, runtime policy, judge commands |
| Policy optimizer | Candidate policy JSON and append-only lineage | Runtime code, frozen tasks, judges, default policy |
| Human operator | Checkpoint decisions and an explicit policy promotion patch | Retrospective trace edits or forced unsafe cleanup |

The approach was informed by outcome-driven recursive-improvement experiments
such as [Weco's published evidence](../reference/claims/bibliography.md#src-weco-recursive-improvement)
and operator/evaluation products such as
[AgentRQ](../reference/claims/bibliography.md#src-agentrq). RAE adopts the
measurable feedback structures while keeping evaluator ownership and runtime
promotion outside the model-controlled loop.

## Adapted explicitly

- Outcome-first measurement. Experimental tasks judge the actual isolated
  worktree with repository-owned verifier cases; model-authored self-reports do
  not decide success. Verifiers execute candidate code only inside an
  evaluator-owned, default-deny OS sandbox with read-only workspace access,
  denied network access, a cleared ambient environment, and a dedicated scratch
  directory. If that sandbox cannot be applied, no candidate code executes and
  the attempt records `evaluator_safety_failure`.
- Bounded policy search. A campaign can compare at most ten data-only policy
  candidates and must retain every accepted, rejected, or blocked decision in
  `lineage.jsonl`.
- Paired and sealed evaluation. Development comparisons require paired wins
  and no paired losses or hard resource regression. The optimizer accepts raw
  outcome reports and recomputes those comparisons against its actual incumbent;
  standalone comparison JSON is not trusted as campaign input. A recommendation
  additionally requires an actual `held-out` outcome report bound to the exact
  policy ID, policy digest, benchmark ID, repeat count, exact evaluator manifest,
  and a task-matrix digest distinct from the development matrix.
- Resource-aware decisions. Duration, input tokens, output tokens, and agent
  calls come from recorded trace events. Missing measurements remain missing
  and block a budgeted recommendation; they are never converted to zero.
- Durable human control. Stop, resume, interrupt, and checkpoint decisions are
  run-scoped records. Decisions include an opaque ID, actor, timestamp, outcome,
  and rationale.
- A local operator surface. The console projects a small event allowlist from
  durable state and supports only explicitly allowlisted Git roots.

## Excluded explicitly

- No runtime source-code self-rewrite.
- No model-authored or task-authored judge command.
- No unsandboxed fallback when the evaluator OS sandbox is absent or rejected.
- No mutation of frozen fixtures, judge code, schemas, or trusted manifests by
  a candidate.
- No automatic replacement of the default autonomous policy.
- No recommendation from development results alone, an unsealed result, a
  policy/digest mismatch, incomplete usage data, or a hard regression.
- No public bind address, remote dashboard, multi-user service, arbitrary
  command provider, environment override, in-place start, commit, push,
  publish, deploy, or forced cleanup control in the operator console.
- No unbounded candidate loop or concurrent server-owned autonomous runs.
- No claim that a POSIX timeout or interrupt contains a descendant that
  deliberately creates a new session. Those paths report containment as
  uncertain and their worktrees require inspection before reuse.

These exclusions are runtime safety boundaries rather than deferred convenience
features. Changing one requires a separate threat model and review.

## Recommended operating order

1. Verify the deterministic contracts and local console tests.
2. Run the default policy on the `dev` outcome split with at least two repeats.
3. Run a proposed policy on the identical task/repeat matrix.
4. Optionally produce paired evidence with `eval compare-outcomes` for review.
5. Give the raw baseline and candidate reports to the offline optimizer; it
   recomputes the paired evidence. A no-recommendation result is a safe,
   successful campaign outcome.
6. Only for an accepted challenger, execute the previously untouched
   `held-out` split and pass that report as sealed evidence.
7. Review the candidate policy, lineage, trusted manifest, resource totals,
   worktree diffs, and residual gaps.
8. Promote by a normal human-authored code change that receives the repository's
   ordinary verification and review. The optimizer never performs this step.

Provider-backed outcome runs require the literal
`--acknowledge-provider-usage` flag. This repository intentionally ships no
precomputed recommendation: a recommendation is evidence, not scaffolding.
The current evaluator backend is macOS Seatbelt; unsupported platforms and
hosts that prohibit `sandbox-exec` fail closed rather than running the judge
directly.

Server and UI contract tests are the deterministic operator-console evidence
lane. A live rendered browser check remains a separate release check, so this
alpha candidate deliberately does not publish a mock or concept screenshot as
runtime evidence.

## Default policy seam

`packages/orchestration/policies/default.autonomous-policy.json` is the current
default. A policy contains only:

- one schema version and policy ID
- bounded guidance text for all ten phases
- validated predecessor-artifact references for all ten phases

The autonomous runner validates and hashes the policy before creating a
worktree, stores its full snapshot in `request.json`, and resumes only from that
snapshot. Policy files cannot select a command, model, tool, sandbox, network,
environment, workspace, or cleanup behavior.

## Operator security boundary

`./scripts/rae.sh operator serve --project <canonical-git-root>` binds to an
ephemeral `127.0.0.1` port. The server issues a 256-bit session token in the URL
fragment; the browser removes the fragment and sends the token only as a bearer
credential. API requests require an exact loopback `Host`, and writes also
require the exact `Origin`. The server uses a strict content security policy,
bounded JSON bodies, opaque project/checkpoint IDs, typed destructive-action
confirmation, and the pipeline's existing fail-closed cleanup validator.

Operator events omit raw provider requests, model messages, provider metadata, token
details, and filesystem paths. The full trace remains local evidence under the
run directory.

## Provider and durable-state boundary

Provider phases receive the task, policy guidance, and policy-selected
predecessor artifacts. The current workspace and output schema remain locally
available to the Codex process. Task files must be relative, regular,
non-symlink `.md` or `.txt` files below the canonical project root; the loader
also rejects credential-like paths, invalid UTF-8, empty files, and files over
128 KiB. Do not put secrets or unrelated private content in task text or
artifacts, and consult the authenticated provider's current data controls for
provider-side handling.

Codex and operator-launched children receive a fixed environment allowlist.
Absolute POSIX, Windows, UNC, and `file:` URL path tokens in predecessor
artifacts are redacted before request construction. Before each writable build
phase, RAE stores an
owner-only byte snapshot of `.pipeline` outside the provider-writable worktree
and temporary roots. Recovery atomically claims that evidence, so concurrent
recovery callers do not both mutate `.pipeline`. A caught restore failure
republishes intact evidence for retry. Unauthorized changes are restored and
reverified before failure reporting. Resume reconciles a crash-left guard
before reading the stored request or state and fails closed if a phase or
recovery claimant may still be active or repository identity cannot be proved.

The CLI-only custom command provider is an explicitly unsafe testing surface.
It has no filesystem or network sandbox and can leave detached descendants.
Every resume must supply a fresh provider name, command, argument, and unsafe
authorization; stored run state cannot authorize it. The operator console does
not expose this provider. Owner-only guard files protect the provider workspace
boundary, not against arbitrary same-user host processes.

## Current evidence boundary

The contracts, deterministic fixtures, fake-provider end-to-end runs, and
request-dispatch tests are locally executable without provider spend. A real
Codex-backed outcome baseline, sealed evaluation, optimizer recommendation, and
live browser render are separate evidence lanes. Until they are actually run,
the implementation is experimental and makes no empirical self-improvement
claim.

## Source note

- [Weco recursive-improvement evidence](../reference/claims/bibliography.md#src-weco-recursive-improvement)
- [AgentRQ](../reference/claims/bibliography.md#src-agentrq)
- [Anthropic effective-agent guidance](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [OpenAI SWE-bench Verified analysis](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [NIST Generative AI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012 verification and validation](../reference/claims/bibliography.md#src-ieee-1012)
