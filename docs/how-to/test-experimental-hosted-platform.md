---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/scripts/verify.sh
evidence_links: ../reference/claims/claims-ledger.md
---

# Test the Experimental Hosted Platform

RAE does not retain a platform-specific automated suite. Run the maintained
orchestration boundary checks instead:

```bash
npm --prefix packages/orchestration run test:runner
npm --prefix packages/orchestration run test:operator
```

These checks cover runner argv, provider-event log, operator CLI, and loopback
security boundaries. They do not establish hosted-platform behavior.

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
