---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/platform
evidence_links: ../reference/claims/claims-ledger.md
---

# Deploy the Experimental Platform

This is a local development procedure, not production deployment guidance. The
checked-in compose file deliberately uses loopback cleartext PostgreSQL and
MinIO ports plus development credentials. Do not publish it, expose it, or
reuse its credentials.

## Prepare configuration

Set `RAE_PLATFORM_CONFIG` to a TOML file containing at least a database URL.
For a local experiment, set `platform.development = true` before enabling
`platform.allowInsecureAuth` or `platform.allowInsecureHttp`. The checked-in
Compose file publishes those development services on loopback only.

For any hosted experiment, omit `allowInsecureAuth` and configure `oidc` with
an exact issuer, audience, JWKS URL, and allowed asymmetric JWS algorithms. Put
the service behind HTTPS.
If artifacts are needed, configure an S3-compatible bucket, region, optional
endpoint, and optional path-style addressing.

## Start the local development stack

From `packages/orchestration/platform/`, review the checked-in development-only
`dev/platform.toml` configuration, set `RAE_DEV_MINIO_ACCESS_KEY` and
`RAE_DEV_MINIO_SECRET_KEY` to disposable local values, then run:

```bash
docker compose -f compose.yaml up --build migrate control
```

The control process never applies migrations automatically. Verify that all
migrations completed before serving work:

```bash
curl http://127.0.0.1:8080/readyz
```

The expected response is `{"status":"ready"}`. `GET /healthz` only proves
that the HTTP process answered. It does not prove schema readiness, OIDC,
object storage, or worker execution.

## Required external evidence

No current repository evidence proves a container deployment, PostgreSQL
integration, OIDC issuer interoperability, S3-compatible upload and
verification, worker execution, or operational recovery. A hosted trial must
record those results separately, including HTTPS termination, secret handling,
database backup and restore, object retention and quarantine handling, and
worker loss recovery.

See [Use the Experimental Hosted API](hosted-api.md) for the route contract.

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
