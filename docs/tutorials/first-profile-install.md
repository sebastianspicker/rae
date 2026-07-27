---
status: experimental
owner: profiles
last_reviewed: 2026-07-16
source_of_truth: profiles/agent-environments
evidence_links: ../reference/repo-map.md
---

# First Profile Install

This repo ships a minimal public profile payload for RAE-shaped targets. Start
by creating a minimal target with `scripts/verify.sh`, then install the public
payload and verify the installed files.

## Install into a clean target

```bash
TARGET_DIR="$(mktemp -d)"
mkdir -p "$TARGET_DIR/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TARGET_DIR/scripts/verify.sh"
chmod +x "$TARGET_DIR/scripts/verify.sh"

bash profiles/agent-environments/installers/install-profile.sh "$TARGET_DIR"
find "$TARGET_DIR" -type f | sort
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
bash profiles/agent-environments/installers/uninstall-profile.sh "$TARGET_DIR"
```

## Verification rule

The shipped regression test is:

```bash
bash profiles/agent-environments/tests/profile-installation.sh
```

## Thesis validation

This tutorial demonstrates the public-profile thesis on a minimal install/remove
path: portable payload first, private overlays excluded.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- successful installation proves payload portability only for the tested public
  surface on an RAE-shaped target with `scripts/verify.sh`

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
