# Agent Environments

Public, sanitized agent environment layer.

This included public surface is part of the proposed `v0.1.0-alpha.1` public
alpha candidate. Interfaces may change; it is not a published release.

## Current committed surface

- `README.md`
  Explains the boundary of the public profile lane.
- `shared/policy/README.md`
  Records the minimum rule set for safe public extraction.
- `shared/policy/operator-policy.md`
  Ships the generic public operator policy.
- `templates/codex/config.toml`
  Provides a sanitized Codex profile template for RAE-shaped targets.
- `templates/claude/settings.json`
  Provides a sanitized Claude profile template for RAE-shaped targets.
- `installers/install-profile.sh`
  Installs the public profile payload only into an RAE-shaped target directory
  with `scripts/verify.sh`, refuses overwrites unless forced, and commits all
  targets plus the manifest as one rollback-capable transaction.
- `installers/uninstall-profile.sh`
  Removes only unmodified files from a validated manifest v2 transaction,
  restores hash-verified original backups, and reports a truthful no-op when
  nothing is installed.
- `installers/profile_transaction.py`
  Keeps the stable install/uninstall CLI and manifest orchestration.
- `installers/profile_io.py`
  Provides descriptor-relative, no-follow filesystem and test-hook primitives.
- `installers/profile_receipts.py`
  Implements guarded quarantine receipts, no-clobber replacement, commit,
  rollback, and retained recovery evidence.

## Publication rule

Only machine-agnostic, sanitized material belongs here. Private overlays,
secrets, host-local hooks, and workstation-specific state stay out of the
public repo until they have been reduced to a reusable public core.

## Support boundary

The published installer is intentionally narrow.

- Supported target: an RAE-shaped repository that already contains `scripts/verify.sh`
- Unsupported target: a generic empty directory or unrelated repo shape

Install success now means the shipped templates can point at a real target-side
verification entrypoint instead of creating a superficially installed but broken
profile.

Manifest v2 records SHA-256 hashes for every installed target and every original
backup. Both install and uninstall prevalidate the complete operation before
mutation and fail closed for legacy v1 manifests, missing or modified files,
tampered backups, symlinks, and non-regular managed paths. The installer holds
no-follow directory descriptors through the transaction; if a concurrent edit
prevents a guarded rollback, it leaves the competing edit untouched and retains
the original material in `.rae-profile-recovery-*/RECOVERY.json` for manual,
reviewed recovery.
