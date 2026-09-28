# Experimental Platform Agent Guide

## Scope

This file applies to `apps/platform/` and adds to the root instructions. The
package is an experimental, separately installed control plane and worker, not
a production deployment or root npm workspace.

## Boundaries

- Import engine behavior only through `@rae/engine`; import contracts through
  `@rae/contracts`.
- Preserve the `/api/v2` and `/mcp` contracts. Do not claim compatibility
  with the operator's `/api/v1` relay without an implemented and tested
  translation adapter.
- Keep migrations explicit and append-only. Do not make `serve` silently
  migrate a database or accept stale schema state.
- Preserve OIDC issuer, audience, JWKS, algorithm, time, subject, scope, and
  project checks. Insecure auth or HTTP remains loopback-development-only.
- Preserve worker identity, fenced leases, idempotency, artifact digest and
  size verification, project-map ownership, and canonical-path checks.
- Treat `compose.yaml` and `dev/` as local fixtures. Do not present them as
  production deployment or operational proof.

## Commands

From the repository root:

```bash
npm ci --prefix apps/platform --ignore-scripts
npm --prefix apps/platform test
npm --prefix apps/platform run test:boundary
```

Control commands are `migrate|doctor|serve`; worker commands are
`doctor|run`. Use disposable credentials and loopback dependencies for local
experiments. Never put tokens, production endpoints, or real project maps in
the repository.

Update `README.md`, the hosted API/deployment/testing pages, architecture, and
security documentation when a public route, configuration, trust boundary, or
evidence claim changes.
