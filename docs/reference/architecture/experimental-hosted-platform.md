---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/platform
evidence_links: ../claims/claims-ledger.md
---

# Experimental Hosted Platform

The hosted platform is an experimental control-plane and worker boundary under
`packages/orchestration/platform/`. The loopback operator can proxy allowlisted
run routes in remote mode, but it is not a production deployment.

## Components

The control process loads TOML configuration, requires explicit database
migrations, checks readiness, and serves a raw Node HTTP surface. PostgreSQL
stores revisions, runs, nodes, leases, attempts, events, an outbox, workers,
and artifact metadata. The worker polls the control plane over HTTPS, renews
its lease, maps logical projects to private canonical Git roots, verifies
local profile digests, runs the sandboxed Codex child, and reports its result.

Optional S3-compatible storage reserves immutable objects by SHA-256 key,
issues five-minute upload and download URLs, and verifies the object digest and
size before marking it verified. A checksum mismatch is copied to a quarantine
key and rejected.

The platform also exposes a stateless Streamable HTTP MCP endpoint. It can
submit, read, signal, or cancel project-authorized runs and read run events. It
does not expose an arbitrary command, Git publication, or deployment action.

## Execution and recovery boundaries

Workers receive 60-second fenced leases and send heartbeats every 20 seconds.
The store accepts heartbeat, report, and artifact finalization only while the
lease is active and its worker and fence match. Expired leases are reconciled
back to queued state. Read nodes may run four-wide; a write node excludes other
active nodes in both the PostgreSQL and in-memory implementations.

Run pinning and explicit rebind require matching repository and worktree
digests from the run and worker. This is an implementation boundary, not proof
that a worker is otherwise isolated or trusted.

## Security boundary

Hosted configuration requires OIDC unless explicit development, insecure-auth,
and insecure-HTTP flags are all set. OIDC validation checks an exact issuer,
audience, JWKS URL, configured asymmetric signing algorithms and token type,
subject, bounded issue time, and unexpired expiration. Routes also require a
named `rae.*` scope and a project claim. Worker identifiers must equal the
token subject.

The development compose file is intentionally not a hosted deployment
configuration. It uses loopback cleartext ports and development credentials
for PostgreSQL and MinIO. The checked-in image runs as `node`, uses a read-only
application filesystem at runtime, and still requires deployment-specific
network, identity, database, object-store, and operational controls.

## Evidence status

Source-unit tests cover canonical revision digests, request idempotency and the
256 KiB run-envelope bound, reader and writer exclusion, fenced completion,
authorization failure, traceparent construction, worker URL validation, and
the two-failed-heartbeat stop rule. They do not prove PostgreSQL migrations,
container startup, OIDC issuer interoperability, S3 compatibility, worker
execution, or a complete hosted recovery path.

See [Hosted API](../../how-to/hosted-api.md),
[experimental deployment](../../how-to/deploy-experimental-platform.md), and
[experimental platform testing](../../how-to/test-experimental-hosted-platform.md).

## Source note

- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../claims/bibliography.md#src-openai-evals)
- [PaperBench](../claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Diataxis](../claims/bibliography.md#src-diataxis)
