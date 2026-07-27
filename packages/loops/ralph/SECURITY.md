# Security Policy

## Supported Scope

Security issues are accepted for:

- `ralph.sh`
- `lib/ralph/*.sh`
- `scripts/*.sh`, `scripts/*.py`
- PRD/runtime validation and path/scope enforcement logic

## Reporting a Vulnerability

Follow the [repository security policy](../../../SECURITY.md) for private
reporting instructions.

When reporting, include:

- affected file(s)
- impact summary
- reproduction steps
- expected vs actual behavior
- suggested mitigation (optional)

## What Is Considered Security-Relevant Here

- path traversal or path escape
- report write outside repository boundary
- scope bypass in `fixing` mode
- lock/race conditions causing unsafe concurrent mutation
- secret leakage into logs/reports
- unsafe default behavior that weakens containment

## Secure Defaults in This Template

- `audit` and `linting` are read-only
- report target path is validated and repository-confined
- `fixing` providers edit an external workspace, not the live checkout
- fixing pointers, journals, and baselines are outside provider workspace and
  temp writable roots
- fixing metadata is bound to canonical root/runtime identities
- promotion atomically quarantines an existing entry before validating it
- promotion and recovery install entries with native no-clobber renames
- concurrent target entries are preserved and conflict evidence is retained
- recovery touches only paths named by the transaction journal and evidence
- Codex runs with an exact child-environment allowlist
- raw output and final report size are bounded
- optional security preflight warns/fails on sensitive env vars
- runtime logs redact common secret/token patterns

## Hardening Recommendations for Consumers

- keep `RALPH_STRICT_REPORT_DIR=true`
- keep `RALPH_SECURITY_PREFLIGHT=true`
- enable `RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK=true` in stricter environments
- run in isolated CI runners for untrusted repositories
- avoid passing unnecessary secrets into the execution environment
- do not use hardlinks, special files, nested repositories, or submodules in a fixing target

The filesystem transaction is recoverable across multiple paths, not globally
atomic. Its concurrent-entry guarantee assumes stable parent directories.
Adversarial parent-directory replacement is outside this path-based boundary
until live renames are anchored to validated directory descriptors. Native
no-clobber rename support is required; unsupported platforms fail closed.

## Disclosure Process

- Maintainers triage and confirm impact
- A fix is prepared and tested
- Documentation and tests are updated
- Public disclosure follows after a fix is available
