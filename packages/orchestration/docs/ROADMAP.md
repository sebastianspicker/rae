# Current limitations and planned work

This page records implementation gaps that affect the orchestration package.
It is not a release schedule.

## Provider execution

- Codex is the only supported autonomous CLI integration.
- Cursor, Claude, Gemini, and Kilo have synchronized guidance adapters but no
  autonomous executor.
- The command provider remains an unsandboxed test interface and cannot pass
  operational diagnostics.

Any additional executor must provide workspace isolation, structured artifact
output, event streaming, fresh sessions, child-environment filtering, deadline
handling, and protected Git-state enforcement before it can be supported.

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
