---
status: experimental
owner: profiles
last_reviewed: 2026-07-16
source_of_truth: profiles/agent-environments
evidence_links: ../reference/repo-map.md
---

# First Profile Install

Build RAE, then install the sanitized profile into a canonical RAE checkout
that defines `npm run verify` and contains its TypeScript or compiled verifier.

## Install into a prepared target

```sh
npm run rae -- profile install /canonical/path/to/rae-checkout
```

The installed payload should include:

- `.codex/config.toml`
- `.claude/settings.json`
- `docs/agent-operator-policy.md`

The installer writes a manifest v2 transaction. It refuses symlinked or other
non-regular managed paths, prevalidates the operation before mutation, and
retains recovery evidence if a concurrent change prevents a guarded rollback.

## Remove the installed payload

```bash
npm run rae -- profile uninstall /canonical/path/to/rae-checkout
```

## Verification rule

Run the public verifier from a prepared checkout:

```bash
npm run verify -- --skip-install
```

## Thesis validation

The install path keeps the payload portable and excludes private overlays, so a
public profile can be installed and removed without workstation-specific state.

## Interpretation limits

- successful installation proves payload portability only for the tested public
  surface on an RAE-shaped target with a Node verification command

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
