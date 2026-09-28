---
status: stable
owner: core
last_reviewed: 2026-07-10
source_of_truth: ../reference/contracts/quality-gates.md
evidence_links: ../reference/invariants/determinism-contracts.md
---

# Quality Policy

RAE uses layered local checks. The verification command is `npm run verify --`;
quality reports are evidence for review.

## Local tool policy

- Strict TypeScript compilation checks package interfaces and validated input
  handling. Biome checks maintained source and respects version-control ignore
  rules.
- The public verifier checks source installation, builds, documentation, and
  runtime entry points.

## Evidence boundary

Run `npm run verify --` from a prepared source checkout. Its result covers the
checks listed above, not a hosted service or external analyzer.

## External references

- [Biome 2.5 release guidance](https://biomejs.dev/blog/biome-v2-5/)

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012 verification and validation](../reference/claims/bibliography.md#src-ieee-1012)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Endsley situation awareness](../reference/claims/bibliography.md#src-endsley-situation-awareness)
