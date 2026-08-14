# Current limitations and planned work

This page records implementation gaps that affect the orchestration package.
It is not a release schedule.

## Provider execution

- Codex remains the default autonomous CLI integration.
- OpenCode is supported only when selected explicitly. The current adapter
  requires macOS Seatbelt containment, an isolated RAE worktree for writes, and
  rejects `--in-place`.
- Cursor, Claude, Gemini, and Kilo have synchronized guidance adapters but no
  autonomous executor.
- The command provider remains an unsandboxed test interface and cannot pass
  operational diagnostics.

Remaining provider work includes a containment backend for other operating
systems, an authenticated OpenCode acceptance run against a real provider event
stream, and broader provider-version coverage. Direct OpenRouter API execution
is not implemented; OpenRouter models are available only through OpenCode
configuration.

Any additional executor must provide workspace isolation, structured artifact
output, event streaming, fresh sessions, child-environment filtering, deadline
handling, and protected Git-state enforcement before it can be supported.

## Workflow designer

The loopback operator implements synchronized Loop, Graph, Analyze, and JSON
views for workflow 2.1. Remaining acceptance work is a rendered browser smoke
and one authenticated proposal-to-activation run. Workflow 2.0 and experimental
2.2 remain expert JSON surfaces rather than guided-editor targets.

## Process containment

The operator console uses POSIX process groups for interruption. It cannot prove
termination when a child deliberately creates a new session. Runs with
uncertain containment require manual inspection before reuse.

## Filesystem transactions

Ralph's no-clobber promotion primitive supports macOS and Linux. Parent
directory replacement is outside the current path-based concurrency guarantee.
Multi-path promotion is recoverable but not globally atomic.

## Evaluation scope

Committed baselines cover their recorded datasets and environments. Additional
task families, operating systems, provider versions, and failure scenarios are
needed before making broader claims.

## Release status

The repository does not publish a package, container, hosted service, or stable
API. Release work is tracked in the root
[`RELEASE_STATUS.md`](../../../RELEASE_STATUS.md) and
[`RELEASING.md`](../../../RELEASING.md).
