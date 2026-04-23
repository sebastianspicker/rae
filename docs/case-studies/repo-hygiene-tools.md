---
status: historical
owner: tools
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../migration/source-repo-map.md
---

# Case Study: Repo Hygiene Tools

Focused maintenance tools belong in the umbrella when they stay narrow, explicit
and separately testable.

## Current example

- `tools/repo-hygiene/coauthor-trailer-cleaner/`

## Why this case matters

The umbrella should not confuse core task execution with one-off maintenance
operations. This tool remains outside the main runtime architecture while still
benefiting from the umbrella’s docs and verification discipline.

## Thesis validation

This case study validates the claim that narrow maintenance tooling should stay
explicitly outside the conceptual center of the runtime.

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
