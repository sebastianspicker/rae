---
status: stable
owner: tools
last_reviewed: 2026-04-12
source_of_truth: tools
evidence_links: ../reference/architecture/module-boundaries.md
---

# Add a Tool

Put a new utility under `tools/` only when it is:

- narrow in scope
- operational rather than architectural
- explicit about destructive behavior
- independently testable

## Checklist

- package README explains the exact task boundary
- tests exist and run in isolation
- the tool does not pretend to be the core runtime
- umbrella docs describe where it fits in the operator workflow

## Thesis validation

This page operationalizes the design claim that maintenance utilities should
remain narrow, explicit, and separately testable instead of being smuggled into
the core runtime.

## Related dossiers

- [CLM-005 narrow utilities outside core runtime](../reference/claims/evidence-index.md#clm-005)

## Interpretation limits

- some useful tools can still grow too broad over time and require reclassification

## Source note

- [Conway 1968](../reference/claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
