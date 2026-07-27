# Contributing

## Before You Start

- Read `README.md` for the package architecture and execution model.
- Read `docs/RUNBOOK.md` for setup, verification, and troubleshooting commands.
- Search open issues before creating a new one.

## Setup

```bash
cd packages/orchestration
npm ci
bash scripts/install-hooks.sh   # optional: install pre-commit hook
./scripts/verify.sh
```

Requirements: Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`;
npm; and Python 3.14.6 or newer.

## Pre-commit Hook

A pre-commit hook is provided that runs Biome lint and format checks on staged `.ts`/`.mjs`/`.js` files. Install it once after cloning:

```bash
bash scripts/install-hooks.sh
```

To skip the hook for a specific commit (not recommended):

```bash
git commit --no-verify
```

## Making Changes

1. Work from the umbrella repo's active branch policy.
2. Make your changes and run verification:

   ```bash
   ./scripts/verify.sh
   ```

3. For runtime skill packages (`skills/dev-tools/*`), also run package-level checks:

   ```bash
   cd skills/dev-tools/<package>
   npm run lint && npm run format:check && npm run build && npm test
   ```

4. Open a pull request. The PR template will guide you through the checklist.

## Repository Rules

- Do not move or rename `manifest.yaml`, `schemas/*`, `src/*`, or `sandbox/*` in runtime skill packages.
- Adapter files under `adapters/<runner>/` are synchronized: edit `adapters/templates/` instead and run:

  ```bash
  python3 scripts/adapters/generate_adapters.py
  ```

- Artifacts must validate against `contracts/artifacts/*.schema.json`.
- Quality gates must validate against `contracts/quality-gate.schema.json`.

## Commit Style

Keep commits small and focused. One logical change per commit. No need for a specific format, but the subject line should describe _what changed_, not _what was done_ (e.g., "Add count-max criterion to quality-gate" not "Update code").

## Security

For security vulnerabilities, follow the process in [SECURITY.md](../../SECURITY.md): do not open a public issue.
