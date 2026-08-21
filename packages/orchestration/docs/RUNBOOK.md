# RUNBOOK

## Requirements
- GNU Bash >= 5.3.
- Python >= 3.14.6.
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0` (see the root
  `package.json` engine contract).
- npm (for `npm ci` / `npm run`).
- ripgrep (`rg`) for stale-ref and hygiene checks.
- Docker (optional, for local sandbox execution).
- Codex CLI (required only for autonomous code-writing runs).

## Autonomous coding run

Verify the model-runner boundary, then execute a task against a target Git
repository:

```bash
npm run agent -- doctor
npm run agent -- run \
  --project-root /path/to/target-repo \
  --task "Implement the change, test it, and update its documentation"
```

The default worktree path and `run-report.md` are printed at completion. Use
`--through plan` for a read-only plan and `resume --run-id <id> --project-root
<reported-workspace>` after correcting a blocker. Resume restores ordinary
Codex tuning, but it never restores command-provider authorization from run
state. A command-provider resume must supply a fresh `--provider command`,
`--agent-command`, at least one `--agent-arg`, and
`--allow-unsafe-command-provider`. The custom provider exists only for tests
and runner-integration development. It always fails doctor because it has no
filesystem or network sandbox.

`--task-file` accepts only a relative, regular, non-symlink `.md` or `.txt`
file below the canonical project root. The runtime opens it without following
the final symlink, reads at most 128 KiB plus one byte through that descriptor,
and rejects identity, size, or timestamp changes before using the text.
Credential paths, traversal, invalid UTF-8, empty files, and oversized files
are rejected before a run is created.

Each run holds `autonomous.lock` for the complete agent/gate sequence. A second
resume fails closed instead of racing workspace edits or artifacts. If a host
crash interrupts a workspace-write phase, resume first reconciles the external
pipeline-state guard. The guard lives under runner state outside the canonical
workspace, `TMPDIR`, and operating-system temporary roots, including when an
in-place repository itself is below a temporary root. The runtime fails closed
when no such location exists. Owner-only modes are defense in depth, not the
isolation boundary; supported Codex workspace-write runs must be unable to
write the runner-state root. Resume restores and reverifies `.pipeline` before
reading the request or state, then removes the stale workflow lock. Recovery
first atomically renames the guard to a PID-scoped claimant path. Other live
claimants fail with `E_PIPELINE_GUARD_CLAIMED` before touching `.pipeline`;
evidence left by a dead claimant can be atomically reclaimed and retried. A
caught restoration failure atomically republishes intact claimant evidence so
the same long-lived process can make a later recovery attempt. Status, stop,
checkpoint, event, and operator-discovery paths likewise refuse an active
guard without reading `.pipeline`, or reconcile it first when its owner is
stale. A guard whose owner may still be running, whose repository identity
changed, or whose restoration cannot be verified fails closed. The unsafe
command provider has no equivalent filesystem-isolation guarantee.

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
5. `check-adapter-sync.sh` (ensures synchronized adapters and mirrors match templates)
6. `check-orchestration-integrity.sh` (validates all runners from `adapters/spec/adapter-manifest.json`)
7. For each runtime package in `skills/dev-tools/*`:
   - `npm ci`
   - `npm run lint` (Biome)
   - `npm run format:check` (Biome)
   - `npm run build` (tsc)
8. Compact Vitest runner-boundary and Node operator-security contracts

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
python3 scripts/check-markdown-links.py --root "$(pwd)" --strict
```
Then, in the relevant package:
```bash
cd skills/dev-tools/quality-gate
npm ci
npm run lint
npm run format:check
npm run build
```
```bash
cd skills/dev-tools/multi-model-review
npm ci
npm run lint
npm run format:check
npm run build
```
```bash
cd skills/dev-tools/trace-collector
npm ci
npm run lint
npm run format:check
npm run build
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
- `npm run test:runner` protects runner argv, provider-event, and operator CLI boundaries.
- `npm run test:operator` protects the operator security boundary.

## Security (minimum baseline)
### Secret scanning
- This repository does not currently configure a Gitleaks workflow.
- Local optional check: `gitleaks detect --source .` when Gitleaks is installed.

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
- CI: CodeQL (`.github/workflows/codeql.yml` from the repository root).

### Application hardening checks (when auditing running web apps)
Use these checks during `security-review` and after fixes:
- Security headers present (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
- Session cookies use `Secure`, `HttpOnly`, and explicit `SameSite`.
- No production debug exposure (stack traces, framework banners, `X-Powered-By`).
- Access-control checks for IDOR/tenant isolation and mass-assignment abuse.
- CSRF protection on all state-changing routes.
- Input abuse checks (SSRF, SQL/NoSQL injection, path traversal, insecure file upload, open redirects, JWT misconfiguration).

## Troubleshooting
- Node version mismatch: use `>=20.19.0 <21`, `>=22.12.0 <23`, or
  `>=24.0.0`.
- Python missing or too old: install Python 3.14.6 or newer and adjust PATH.
- `npm ci` fails: delete `node_modules` and retry.
- `agent doctor` fails: update Codex CLI until `exec --help` exposes
  `--sandbox`, `--output-schema`, and `--ephemeral`.
- a phase gate fails: inspect the named gate and `run-report.md`, correct the
  target or missing tool, then resume from the reported worktree.

## Local cleanup utility
Remove local junk/caches without changing tracked source files:
```bash
./scripts/clean-local.sh
```
