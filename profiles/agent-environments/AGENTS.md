# Agent Environment Profile Guide

## Scope

This file applies to `profiles/agent-environments/`. The subtree publishes
sanitized templates and filesystem-mutating installers for RAE-shaped targets.

## Safety contract

- Keep templates machine-agnostic and free of credentials, personal paths,
  private overlays, and host-local hooks.
- Preserve inventory-first validation, descriptor-relative no-follow I/O,
  owner checks, hash-verified backups, no-clobber replacement, and
  rollback/recovery receipts.
- Installation must refuse an unrelated target and must not overwrite unless
  the caller explicitly uses the supported force option.
- Uninstallation removes only manifest-owned, unmodified files and restores
  only verified backups.
- Treat `.rae-profile-install.json` and
  `.rae-profile-recovery-*/RECOVERY.json` as protocol data. Update the
  manifest version for incompatible semantics.
- Never exercise mutation paths against a personal or production directory
  while developing. Use a disposable RAE-shaped fixture.

## Verification

From the repository root:

```bash
profiles/agent-environments/installers/install-profile.sh --help
profiles/agent-environments/installers/uninstall-profile.sh --help
npm run verify -- --skip-install
```

Update `README.md` and the profile tutorial when the payload, manifest,
transaction, supported target, or recovery behavior changes.
