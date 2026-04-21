---
status: stable
owner: profiles
last_reviewed: 2026-04-12
source_of_truth: profiles/agent-environments
evidence_links: ../reference/claims/assumptions-register.md
---

# Publish a Sanitized Profile

Public profile material must be:

- machine-agnostic
- free of secrets and local overlays
- documented with clear boundaries between public core and private overrides

## Minimum publication workflow

1. Extract only reusable policy, templates, and install steps from the private
   profile source.
2. Remove hostnames, usernames, tokens, vault paths, API keys, and local file
   assumptions.
3. Keep the committed public surface auditable with:

   ```bash
   find profiles/agent-environments -maxdepth 3 -type f | sort
   ```

4. Add or update explanatory docs so the public lane states exactly what is
   shipped and what remains private.
5. Re-run `./scripts/verify.sh` before publication.

## What belongs here

- shared agent policy that is safe to publish
- portable templates
- generic installation steps
- tests that validate public install/remove behavior without private state

## Current public payload

The repo ships:

- `profiles/agent-environments/installers/install-profile.sh`
- `profiles/agent-environments/installers/uninstall-profile.sh`
- `profiles/agent-environments/templates/codex/config.toml`
- `profiles/agent-environments/templates/claude/settings.json`
- `profiles/agent-environments/shared/policy/operator-policy.md`
- `profiles/agent-environments/tests/profile-installation.sh`

## What does not belong here

- secrets or secret-shaped placeholders that encode real infrastructure
- machine-local hooks or paths
- private overlays copied verbatim from workstation repos
- empty scaffolds that imply a shipped public profile where none exists

## Thesis validation

This page operationalizes the claim that operator-environment publication is
only reliable when the public payload is machine-agnostic, auditable, and free
of private overlays.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- sanitization improves public reproducibility but cannot encode every private
  operator habit safely

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
- [Parasuraman and Riley](../reference/claims/bibliography.md#src-parasuraman-riley)
