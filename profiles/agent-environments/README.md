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
- `src/cli.ts` and `src/profile.ts`
  Implement the Node install/uninstall CLI and manifest orchestration.
- `src/io.ts` and `src/receipts.ts`
  Preserve descriptor-relative no-follow transactions, guarded quarantine,
  hash-verified backups, rollback and retained recovery evidence.

From a built RAE checkout, run `npm run rae -- profile install /canonical/target`
or `npm run rae -- profile uninstall /canonical/target`.

## Publication rule

Only machine-agnostic, sanitized material belongs here. Private overlays,
secrets, host-local hooks, and workstation-specific state stay out of the
public repo until they have been reduced to a reusable public core.

## Support boundary

The published installer is intentionally narrow.

- Supported target: an RAE-shaped repository with a Node verifier and a `package.json` `verify` script
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

Run the disposable transaction fixtures from the repository root:

```bash
npm run test:profiles
```

The repository gate includes these fixtures. They do not mutate personal
repositories; simulated remote Git operations use a local bare repository.

New installs require `scripts/src/verify.ts` or `scripts/dist/verify.js` and a
package verification command. Uninstall still accepts legacy verifier layouts
so existing manifest-v2 receipts remain recoverable. The historical installer
identifier stored in those receipts is unchanged.
