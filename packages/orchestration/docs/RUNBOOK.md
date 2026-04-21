# RUNBOOK

## Requirements
- Node.js >= 20 (see `skills/dev-tools/*/package.json` engines).
- npm (for `npm ci` / `npm run`).
- Python 3 (for `scripts/skills/validate_skills.py`).
- ripgrep (`rg`) for stale-ref and hygiene checks.
- Docker (optional, for local sandbox execution).

## Full CI Verification
The primary check for all code, types, and schema validity:
```bash
./scripts/verify.sh
```
This runs:
1. `validate_skills.py` (checks `.codex` and all manifest-declared `adapters/*/skills` roots)
2. `check-no-stale-refs.sh` (ensures outdated internal links don't leak outside `_archive`)
3. `check-repo-hygiene.sh` (fails on tracked local junk files such as `.DS_Store`)
4. `check-markdown-links.py` (checks relative Markdown links in `README.md` and `docs/*.md`)
5. `check-adapter-sync.sh` (ensures generated adapters/mirrors match templates)
6. `check-orchestration-integrity.sh` (validates all runners from `adapters/spec/adapter-manifest.json`)
7. For each runtime package in `skills/dev-tools/*`:
   - `npm ci`
   - `npm run lint` (Biome)
   - `npm run format:check` (Biome)
   - `npm run build` (tsc)
   - `npm test` (vitest)

## Fast changed-only verification
Use this for PR/local fast feedback:
```bash
./scripts/verify.sh --changed-only
```

You can override the diff base:
```bash
./scripts/verify.sh --changed-only --changed-base origin/dev
```

## Fast loop (per-package)
From repo root:
```bash
python3 scripts/skills/validate_skills.py --manifest "$(pwd)/adapters/spec/adapter-manifest.json"
python3 scripts/adapters/generate_adapters.py --check
python3 scripts/check-markdown-links.py --root "$(pwd)"
```
Then, in the relevant package:
```bash
cd skills/dev-tools/quality-gate
npm ci
npm run lint
npm run format:check
npm run build
npm test
```
```bash
cd skills/dev-tools/multi-model-review
npm ci
npm run lint
npm run format:check
npm run build
npm test
```
```bash
cd skills/dev-tools/trace-collector
npm ci
npm run lint
npm run format:check
npm run build
npm test
```

## Worktree-backed isolated runs

For long-horizon work that should not share a working copy with other runs:

```bash
./scripts/pipeline-init.sh . --use-worktree
```

This creates:

- a dedicated branch: `pipeline/<run-id>`
- a dedicated checkout under `<repo-root>/.worktrees/<run-id>`
- pipeline state and traces inside that isolated checkout

When you start from a package subdirectory, worktree mode normalizes to the git
repository root before creating the checkout. The init output prints the exact
`workspace_root`. Run the pipeline from that reported path:

```bash
cd <workspace_root>
node scripts/pipeline/runner.mjs run-stage --run-id <run-id> --phase arm
```

Operator-facing summary artifacts are also available:

```bash
node scripts/pipeline/runner.mjs summarize-progress --run-id <run-id>
node scripts/pipeline/runner.mjs summarize-progress --run-id <run-id> --format markdown
```

The command writes `.pipeline/runs/<run-id>/progress.summary.json` and can also
emit text or Markdown summaries for later CLI/UI rendering.

Cleanup is explicit and idempotent:

```bash
./scripts/pipeline-init.sh --cleanup-worktree <repo-root>/.worktrees/<run-id>
```

## Lint / Format
- `npm run lint` (Biome check) per runtime package.
- `npm run format:check` (Biome format verification) per runtime package.

## Typecheck
- `npm run build` (per package, uses `tsc -p tsconfig.json`).

## Build
- Same as typecheck: `npm run build` per package.

## Tests
- `npm test` (per package, runs `vitest run`).

## Security (minimum baseline)
### Secret scanning
- CI: Gitleaks (`.github/workflows/security.yml`). For org accounts, set `GITLEAKS_LICENSE` secret if required.
- Local (optional): `gitleaks detect --source .` (requires gitleaks installed).

### SCA / dependency scanning
From repo root:
```bash
cd skills/dev-tools/quality-gate
npm ci
npm audit --audit-level=high
```
```bash
cd skills/dev-tools/multi-model-review
npm ci
npm audit --audit-level=high
```
```bash
cd skills/dev-tools/trace-collector
npm ci
npm audit --audit-level=high
```

### SAST
- CI: CodeQL (`.github/workflows/security.yml`).

### Application hardening checks (when auditing running web apps)
Use these checks during `security-review` and after fixes:
- Security headers present (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
- Session cookies use `Secure`, `HttpOnly`, and explicit `SameSite`.
- No production debug exposure (stack traces, framework banners, `X-Powered-By`).
- Access-control checks for IDOR/tenant isolation and mass-assignment abuse.
- CSRF protection on all state-changing routes.
- Input abuse checks (SSRF, SQL/NoSQL injection, path traversal, insecure file upload, open redirects, JWT misconfiguration).

## Troubleshooting
- Node version mismatch: ensure Node >= 20.
- Python not found: install Python 3 or adjust PATH.
- `npm ci` fails: delete `node_modules` and retry.

## Local cleanup utility
Remove local junk/caches without changing tracked source files:
```bash
./scripts/clean-local.sh
```
