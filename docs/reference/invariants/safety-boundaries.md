---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../claims/claims-ledger.md
---

# Safety Boundaries

## Repository boundaries

- public profiles must not ship private overlays or host-specific secrets
- imported modules should remain runnable without absorbing unrelated state from
  neighboring modules
- eval artifacts must not silently mutate source repositories

## Documentation boundaries

- explanation pages must not masquerade as benchmark evidence
- benchmark claims require frozen metadata and provenance
- provisional claims must be labeled as such

## Tooling boundaries

- focused repo-hygiene tools must keep destructive actions explicit
- deterministic loops must constrain write scope and state mutation
- orchestration gates must remain distinct from the artifacts they evaluate
- worktree-backed orchestration runs must record workspace root, primary repo
  root, branch, and cleanup contract in pipeline state and trace artifacts
- isolated orchestration runs must not silently mutate the primary checkout when
  the operator selected worktree-backed execution

## Thesis validation

This page validates the claim that safety comes from explicit boundaries on
write scope, publication semantics, and destructive operations rather than from
informal operator caution alone.

## Related dossiers

- [CLM-017 documentation reliability](../claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- boundary rules reduce common failure modes but still depend on runtime
  enforcement and review discipline

## Source note

- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../claims/bibliography.md#src-endsley-situation-awareness)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
