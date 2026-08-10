---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/platform/src/http.mjs
evidence_links: ../reference/claims/claims-ledger.md
---

# Use the Experimental Hosted API

This API is an experimental control-plane surface. The loopback operator can
proxy its allowlisted run routes in remote mode, but it does not provide a
production service and must not be exposed with local insecure authentication.

## Prerequisites

Configure the control process with `RAE_PLATFORM_CONFIG` and apply migrations
before serving. Hosted callers need a bearer token accepted by the configured
OIDC issuer, audience, and signing-algorithm policy. The token must contain an
unexpired `exp`, a bounded `iat`, a subject, the required `rae.*` scope, and an authorized
`projects` or `project_ids` claim.

The control process exposes unauthenticated `GET /healthz`, `GET /readyz`, and
`GET /metrics`. `GET /readyz` returns `503` until every checked-in migration is
recorded. `GET /.well-known/oauth-protected-resource` describes the MCP
resource when OIDC is configured.

## Route groups

| Route | Required scope | Notes |
| --- | --- | --- |
| `POST /api/v2/revisions`, activate, or diff | `rae.policy.write` | Uploads, validates, compares, or activates an exact immutable revision. Activation requires `Idempotency-Key`. |
| `POST /api/v2/runs` | `rae.run.submit` | Requires `Idempotency-Key`; the run envelope is limited to 256 KiB. |
| `GET /api/v2/runs/<id>` and `/events` | `rae.run.read` | Reads an authorized run or its events; `?stream=true&from=<id>` opens bounded SSE. |
| `POST /api/v2/runs/<id>/cancel` | `rae.run.cancel` | Requires `Idempotency-Key`. |
| `POST /api/v2/runs/<id>/signals` | `rae.run.signal` | Requires `Idempotency-Key`. |
| `POST /api/v2/runs/<id>/rebind` | `rae.run.cancel` | Requires `Idempotency-Key`, an operator decision, and matching digests. |
| Worker register, claim, and heartbeat | `rae.work.claim` | Worker subject must equal the supplied stable worker identifier. |
| Worker report, failure, and artifact upload | `rae.work.report` | Reports require the current fenced lease. |
| Artifact download | `rae.run.read` | Available only for authorized projects when storage is configured. |
| `POST /mcp` | Per-tool `rae.run.*` scope | Stateless Streamable HTTP MCP compatibility surface. |

All listed routes are implementation references, not a stability commitment.
The request parser accepts JSON bodies up to 1,050,000 bytes. Mutating run
operations named above enforce `Idempotency-Key`; callers must provide one for
every mutation. Revision upload also computes and verifies the supplied digest.

## Worker protocol

Register first, then claim work. A worker uses HTTPS, long-polls for up to 25
seconds, sends a heartbeat every 20 seconds, and reports success or failure
with the claim's node identifier and fence value. A lost heartbeat aborts the
current worker operation rather than reporting a stale result.

The worker resolves the claim's logical project ID through its private
`RAE_PROJECT_MAP_FILE`, verifies the claim's profile digest against the local
execution-profile v2 snapshot, replaces all filesystem paths locally, and
runs the existing sandboxed workflow-agent child. The map must be an
owner-only regular file and each root must be a canonical Git top level.

Each provider-node payload must contain `prompt`, `outputSchema`,
`profileDigest`, and a logical `tier`; it may contain a bounded
`timeoutSeconds`. The control plane supplies only the logical project, run,
attempt, and node identities plus read/write access. The worker derives the
workspace root, output paths, Codex model, reasoning effort, credentials, and
MCP allowlist from its local map and matching profile snapshot.

For the deployment boundary, see
[Deploy the Experimental Platform](deploy-experimental-platform.md).

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
