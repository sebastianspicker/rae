---
status: historical
owner: tools
last_reviewed: 2026-07-16
source_of_truth: editorial
evidence_links: ../reference/repo-map.md
---

# Case Study: Repo Hygiene Tools

Focused maintenance tools belong in the umbrella when they stay narrow, explicit,
and separately testable.

## Current example

- `tools/repo-hygiene/coauthor-trailer-cleaner/`

The included coauthor trailer cleaner `3.0.0` defaults to `--no-push`. It
rewrites a private ref pinned to a captured OID, retains recovery data under
concurrent changes, and uses compare-and-swap checks with atomic cleanup.

## Why this case matters

Keep core task execution separate from one-off maintenance. This tool lives
outside the main runtime, but it still follows the umbrella's documentation and
verification rules.

## Thesis validation

Maintenance tooling should stay outside the conceptual center of the runtime,
even when the same repository ships it.

## Related dossiers

- [CLM-005 narrow utilities outside core runtime](../reference/claims/evidence-index.md#clm-005)

## Interpretation limits

- narrow scope still requires strong guardrails when a tool can rewrite history

## Source note

- [Conway 1968](../reference/claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
