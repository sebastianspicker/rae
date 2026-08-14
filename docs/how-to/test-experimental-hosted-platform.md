---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/platform/test/platform.test.mjs
evidence_links: ../reference/claims/claims-ledger.md
---

# Test the Experimental Hosted Platform

Run the focused source-unit suite from the platform package:

```bash
npm --prefix packages/orchestration/platform test
```

The current suite uses the in-memory store. It verifies canonical revision
digests, digest mismatch rejection, idempotent run submission, the 256 KiB run
envelope limit, four-reader writer exclusion, authorization failure, and
traceparent format.

Run the workflow 2.2 contract suite separately:

```bash
npm --prefix packages/orchestration run test:runner -- workflow-v22.test.mjs
```

That suite covers bounded and ordered context, artifact references instead of
partial predecessor objects, fail-closed context overflow, idempotent signals,
local resume, and timeout routing.

The focused tests do not start Docker, PostgreSQL, MinIO or another S3 service,
an OIDC issuer, or a remote worker. They do not prove hosted deployment,
database migration behavior, token interoperability, presigned URL transfer,
or end-to-end worker recovery. Record those as integration evidence before
describing the platform as deployable.

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
