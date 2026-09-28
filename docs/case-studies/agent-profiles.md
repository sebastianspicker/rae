---
status: historical
owner: profiles
last_reviewed: 2026-07-16
source_of_truth: editorial
evidence_links: ../reference/repo-map.md
---

# Case Study: Agent Profiles

The profile lane turns private operator-environment knowledge into a public
payload only after sanitization.

## Why it matters

Without a public profile layer, operator reproducibility depends too heavily on
private machine history.

## Current state

RAE ships a baseline public payload under `profiles/agent-environments/`:
generic templates, install/remove scripts, and a regression test that checks for
forbidden private markers.

The current installer uses manifest v2, descriptor-relative no-follow file
operations, complete prevalidation, and recovery records for interrupted or
concurrently changed transactions.

## Thesis validation

Public operator environments need a sanitized publication lane. A direct copy of
private workstation state is neither portable nor safe to share.

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
