# Experimental hosted platform

This package is an experimental RAE hosted control-plane vertical slice. The
package is not a production deployment. Its `/api/v2` and `/mcp` surfaces
are not connected to the loopback operator, whose remote relay allows only the
operator `/api/v1` contract.

It owns PostgreSQL control-plane state, OIDC-protected REST endpoints, fenced
worker leases, S3-compatible artifact storage, and a narrow Streamable HTTP MCP
surface. It has a separate lockfile and is not part of the root npm workspace.
From the repository root:

```bash
npm ci --prefix apps/platform --ignore-scripts
npm run build
npm --prefix apps/platform run build
npm --prefix apps/platform run control -- doctor
```

Control commands are `migrate`, `doctor`, and `serve`. Worker commands are
`doctor` and `run`. Both require the environment described below.

An intentionally local-only insecure configuration is useful for unit and
manual experiments. Hosted use must supply the `oidc` section instead.

```toml
[server]
host = "127.0.0.1"
port = 8080
publicBaseUrl = "http://127.0.0.1:8080"

[database]
url = "postgres://rae:rae@127.0.0.1:5432/rae_platform"

[platform]
development = true
allowInsecureAuth = true
allowInsecureHttp = true
# These values are deliberately fixed. Workers renew every 20 seconds and a
# completed or expired lease cannot be reported by an older fence value.
leaseSeconds = 60
heartbeatSeconds = 20

[storage]
bucket = "rae-artifacts"
region = "us-east-1"
endpoint = "http://127.0.0.1:9000"
forcePathStyle = true
```

For hosted use, remove `allowInsecureAuth`, bind the service behind HTTPS, and
configure an exact issuer, audience, JWKS URL, and allowed asymmetric JWS
algorithms. Tokens must carry an unexpired `exp`, a bounded `iat`, a subject,
scopes, and a `projects` or `project_ids` claim.
The worker identifier must equal the OIDC token subject. Artifact reservations
and final verification are bound to that worker's active node and lease fence.

Workers require `RAE_PROJECT_MAP_FILE` to name an owner-only TOML file mapping
each logical project ID to a canonical local Git root and a snapshotted
execution-profile v2 file. See `dev/projects.toml.example`. Absolute roots and
profile paths stay on the worker and are never reported to the control plane.
Integration tests are intentionally skipped unless
`RAE_PLATFORM_DATABASE_URL` is configured.

Worker claims wait through a shared PostgreSQL notification listener. Each
claim probe opens a short transaction and releases every row and advisory lock
before waiting. Run creation and expired-lease reconciliation wake waiters;
the worker retries for at most 25 seconds. A successful claim is persisted
with its idempotency key in the claiming transaction, while an empty result is
persisted only when the requested wait expires. A dropped notification
connection is discarded and re-established before the worker waits again.
Periodic expiry cleanup uses bounded, skip-locked batches, while claim probes
do no global lease cleanup, so a locked expired lease cannot stall unrelated
claims. Store shutdown cancels pending claim
waiters and waits for an in-flight notification connection before releasing
its client, so no poll retries against an ended pool.

Node reports lock the owning run and commit the fenced attempt, node state,
immutable event, and outbox record together. The run becomes terminal only
after every node is terminal. Any failed node makes the run failed; otherwise
it succeeds. Cancellation uses the same run lock and cannot be overwritten by
a concurrent report. Event streams read bounded pages after their cursor,
honor response backpressure, stop on disconnect, and drain committed terminal
events before closing. The non-streaming event response remains the complete
JSON event array. Graceful control-process shutdown aborts tracked event streams
before waiting for connections and force-closes remaining sockets after a
bounded grace period.

`POST /api/v2/runs` accepts an `Idempotency-Key`; the control plane commits the
revision, run, queued nodes, event, and outbox record in one PostgreSQL
transaction. Worker claim and heartbeat routes require `rae.work.claim`, worker
reports require `rae.work.report`, run reads require `rae.run.read`, and run
creation requires `rae.run.submit`. `/mcp` is a
allowlisted JSON-RPC MCP compatibility endpoint exposing run data and immutable
events. It is implemented with the MCP SDK's stateless Streamable HTTP
transport and publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource`. The operator's separate remote mode
can relay a compatible hosted operator service without exposing its upstream
token to browser code, but it cannot relay this platform API without a version
translation adapter.

The documented HTTP surface begins at `/api/v2`. All mutations require an
`Idempotency-Key`; scopes are `rae.*`. Run envelopes are limited to 256 KiB.
Change to `apps/platform` for the following development commands.
For an isolated cleartext development stack, review `dev/platform.toml` and set
`RAE_DEV_MINIO_ACCESS_KEY` and `RAE_DEV_MINIO_SECRET_KEY` to disposable local
values. Start only the loopback-published dependencies with `docker compose -f
compose.yaml up -d postgres minio minio-init`, then run the migration and
control process on the host so its anonymous development surface remains bound
to the host loopback interface:

```bash
RAE_PLATFORM_CONFIG="$PWD/dev/platform.toml" npm run control -- migrate
RAE_PLATFORM_CONFIG="$PWD/dev/platform.toml" npm run control -- serve
```

`curl http://127.0.0.1:8080/readyz` must then return `ready`.
Production deployments require HTTPS and must not use this development compose
file or its development credentials.

See the [platform architecture
reference](../../docs/reference/architecture/experimental-hosted-platform.md),
and [local deployment experiment](../../docs/how-to/deploy-experimental-platform.md).
