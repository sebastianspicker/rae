# RAE Shared Memory

This file is the umbrella memory surface for repeated operator corrections,
workflow rules, and escalation defaults.

Package-local docs remain the command-level source of truth. Add guidance here
 only when it applies across more than one runtime or benchmark family.

## Update Rules

- Record only durable corrections that should compound across sessions.
- Prefer replacing stale guidance over stacking exceptions.
- Keep runtime-specific command details in package-local docs.
- Every new memory entry should name the trigger, the rule, and the escalation
  condition.
- Review this file whenever the umbrella workflow or verification contract
  changes.

## Workflow Verbs

- `discover`
  Inspect the repo, gather context, and identify the smallest adequate runtime.
- `plan`
  Declare scope boundaries, dependencies, verification targets, guards, and
  evidence expectations before non-trivial execution.
- `implement`
  Change only the declared in-scope surfaces and preserve package-local
  invariants.
- `review`
  Produce evidence-bearing verification artifacts, residual-risk summaries, and
  release-gate inputs.
- `compound`
  Turn repeated corrections into shared repo assets such as docs, contracts,
  skills, or commands.

## Escalation Rules

- Escalate when requested work crosses an undeclared boundary.
- Escalate when `verify` or `guard` commands are missing for a non-trivial task.
- Escalate when user-surface or high-risk changes lack visible proof.
- Escalate when profile installers or cleanup tools would follow symlinked
  managed paths or manifest-provided paths outside the declared target tree.
- Use worktree-backed execution for long-horizon or parallel efforts that should
  not share one checkout.
- Prefer the smallest adequate runtime: tool before Ralph, Ralph before
  orchestration.

## Quality Rule

Reusable workflow assets should make four things explicit:

- boundary
- verification
- guard
- evidence

The formal admission rubric lives in
`docs/reference/workflow-rubric.md`.
