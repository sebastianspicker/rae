---
status: historical
owner: profiles
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../archive/migration/source-repo-map.md
---

# Case Study: Agent Profiles

The profile lane is where private operator-environment knowledge becomes public
only after sanitization.

## Why it matters

Without a public profile layer, operator reproducibility depends too heavily on
private machine history.

## Current state

The umbrella ships a baseline public payload under
`profiles/agent-environments/`: generic templates, install/remove scripts, and
a regression test that checks for forbidden private markers.

## Thesis validation

This case study validates the claim that public operator environments need a
sanitized publication lane rather than direct leakage from private workstation
state.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- the current payload is a baseline publication surface, not a universal profile
  standard

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
- [Parasuraman and Riley](../reference/claims/bibliography.md#src-parasuraman-riley)
