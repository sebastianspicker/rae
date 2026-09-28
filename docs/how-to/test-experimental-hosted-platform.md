---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: apps/platform/package.json
evidence_links: ../reference/claims/claims-ledger.md
---

# Test the Experimental Hosted Platform

Run the platform's source-level trust-boundary tests together with the engine
and operator boundaries:

```bash
npm run test:engine
npm run test:operator
npm run test:platform
```

These checks cover engine arguments and provider-event logs, operator loopback
security, engine-facade use, artifact symlink defenses, bind policy, and worker
address validation. They do not establish a deployed hosted platform.

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
