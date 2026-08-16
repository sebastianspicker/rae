# Experimental hosted platform

This package is an experimental RAE hosted control-plane vertical slice. The
local operator can proxy its allowlisted run routes in remote mode, but the
package is not a production deployment.

It owns PostgreSQL control-plane state, OIDC-protected REST endpoints, fenced
worker leases, S3-compatible artifact storage, and a narrow Streamable HTTP MCP
surface. Start only after configuring `RAE_PLATFORM_CONFIG`:

```bash
npm run control -- serve
npm run worker -- doctor
```

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

The control CLI supports `migrate`, `doctor`, and `serve`. The worker CLI
supports `doctor` and `run`. Workers require `RAE_PROJECT_MAP_FILE` to name an
owner-only TOML file mapping each logical project ID to a canonical local Git
root and a snapshotted execution-profile v2 file. See
`dev/projects.toml.example`. Absolute roots and profile paths stay on the
worker and are never reported to the control plane. Integration tests are
intentionally skipped unless `RAE_PLATFORM_DATABASE_URL` is configured.

`POST /api/v2/runs` accepts an `Idempotency-Key`; the control plane commits the
revision, run, queued nodes, event, and outbox record in one PostgreSQL
transaction. Worker claim and heartbeat routes require `rae.work.claim`, worker
reports require `rae.work.report`, run reads require `rae.run.read`, and run
creation requires `rae.run.submit`. `/mcp` is a
allowlisted JSON-RPC MCP compatibility endpoint exposing run data and immutable
events. It is implemented with the MCP SDK's stateless Streamable HTTP
transport and publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource`. It is not connected to RAE's existing
operator JavaScript; the operator's loopback server proxies allowlisted routes
without exposing the upstream token to browser code.

The documented HTTP surface begins at `/api/v2`. All mutations require an
`Idempotency-Key`; scopes are `rae.*`. Run envelopes are limited to 256 KiB.
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
