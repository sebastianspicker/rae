# Security Policy

## Supported Scope

Security issues are accepted for:

- `ralph.sh`
- `lib/ralph/*.sh`
- `scripts/*.sh`
- PRD/runtime validation and path/scope enforcement logic

## Reporting a Vulnerability

Please report vulnerabilities privately to the maintainers.

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
- `fixing` changes are scope-validated using pre/post state snapshots
- optional security preflight warns/fails on sensitive env vars
- runtime logs redact common secret/token patterns

## Hardening Recommendations for Consumers

- keep `RALPH_STRICT_REPORT_DIR=true`
- keep `RALPH_SECURITY_PREFLIGHT=true`
- enable `RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK=true` in stricter environments
- run in isolated CI runners for untrusted repositories
- avoid passing unnecessary secrets into the execution environment

## Disclosure Process

- Maintainers triage and confirm impact
- A fix is prepared and tested
- Documentation and tests are updated
- Public disclosure follows after a fix is available
