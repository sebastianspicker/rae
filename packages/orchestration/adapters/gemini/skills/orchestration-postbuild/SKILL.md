---
name: orchestration-postbuild
description: "Gemini adapter for post-build checks. Runs cleanup plus frontend/backend/docs/security audits and aggregates outcomes into a gate result."
---

# Post-Build - Cleanup and Audit Pass (Gemini Adapter)

## Use this when
- `quality-tests` gate has passed.
- The user requests post-build quality checks or any of: `/denoise`, `/qf`, `/qb`, `/qd`, `/security-review`.

## Model tier
Use fast worker models for audit tasks.

## Semantic intent
- Separation of duties: post-build audits validate implementation from a distinct audit context.
- Evidence-first guidance: every violation should include reproducible evidence and remediation.

## Input
- Changed implementation files
- `.pipeline/runs/<run-id>/plan.json`

## Procedure

### 1. Denoise first
Run cleanup before audits:
- remove dead imports/unused vars/debug leftovers,
- preserve behavior,
- rerun tests.

Write:
- `.pipeline/runs/<run-id>/quality-reports/denoise.json`

### 2. Run audits (parallel)
Execute up to 4 independent Task subagents:
- Frontend quality (`/qf`)
- Backend quality (`/qb`)
- Documentation freshness (`/qd`)
- Security review (`/security-review`) with mandatory remediation loop:
  - access-control checks (IDOR, privilege escalation, mass assignment),
  - XSS/CSRF checks (including CSP and CSRF token enforcement),
  - secret/key leak scan (hardcoded API keys, tokens, credentials),
  - header hardening audit (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy),
  - cookie/session audit (`Secure`, `HttpOnly`, `SameSite`, token storage),
  - production exposure audit (server versions/banners, debug info/stack traces),
  - server-side abuse checks (SSRF, SQL/NoSQL injection, command injection),
  - file/path checks (insecure upload validation, traversal, archive extraction),
  - redirect and JWT checks (open redirect, JWT algorithm/expiry/storage validation),
  - dependency vulnerability audit (`npm audit` or ecosystem equivalent),
  - fix critical/high findings and rerun scans before closure.

Write reports:
- `.pipeline/runs/<run-id>/quality-reports/frontend.json`
- `.pipeline/runs/<run-id>/quality-reports/backend.json`
- `.pipeline/runs/<run-id>/quality-reports/docs.json`
- `.pipeline/runs/<run-id>/quality-reports/security.json`

### 3. Aggregate
Combine report summaries and highlight critical/high violations.

Write combined gate:
- `.pipeline/runs/<run-id>/gates/postbuild-gate.json`

### 4. Gate conditions
- no critical violations overall,
- no high security violations,
- tests still green after cleanup,
- public API changes reflected in docs.
- all security findings are either `fixed` or explicitly `accepted-risk` with owner + expiry.
- security report includes mandatory category coverage and fix-loop evidence (`before` vs `after` counts).

## Optional single-audit mode
Any audit command can be run independently and should still emit its corresponding report artifact.
