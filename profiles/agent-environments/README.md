# Agent Environments

Public, sanitized agent environment layer.

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
  Installs the public profile payload only into an RAE-shaped target directory with `scripts/verify.sh`, refuses overwrites unless forced, and records hashes/backups for safe uninstall.
- `installers/uninstall-profile.sh`
  Removes only unmodified files previously installed by this profile, restores any files overwritten via `--force`, and reports a truthful no-op when nothing is installed.
- `tests/profile-installation.sh`
  Verifies install/remove behavior and checks for forbidden private markers.

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
