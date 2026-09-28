# Contributing

## Scope of This Repository

This repository is a reusable template. Changes should improve one or more of these areas:

- loop correctness
- safety and containment
- deterministic behavior
- portability
- documentation clarity
- regression coverage

## Local Setup

Required tools:

- Node.js 24 or newer and npm

Optional but useful:

- `git`
- `codex` (needed only for execution flows, not for most tests)

## Development Rules

- Give every TypeScript source file a short opening comment that states its purpose.
- Keep TypeScript strict and avoid `any`, `@ts-ignore`, and `@ts-nocheck` escapes.
- Prefer explicit failure handling over silent fallback.
- Avoid broad refactors mixed with behavior changes.
- Preserve deterministic behavior of the story loop.
- Keep security-sensitive behavior conservative by default.

## CI

On push and pull requests, GitHub Actions runs the full repository verification gate, which includes this package's test suite. See [../../.github/workflows/ci.yml](../../.github/workflows/ci.yml).

## Testing Requirements

Before opening a PR:

1. Run the compiled TypeScript checks:

```bash
npm test
npm run typecheck
```

2. If behavior changes, add or update tests in `tests/`.

## Documentation Requirements

For non-trivial behavior changes:

- Update canonical sections in `README.md`.
- Keep examples consistent with actual CLI/env behavior.
- If you change `defaults.report_dir`, update both `prd.json` /
  `prd.json.example` and any example acceptance criteria that reference the
  report path.

## Commit and PR Guidance

Use focused commits with clear intent.

Suggested commit style:

- `fix(runner): fail hard on metadata snapshot errors`
- `docs(readme): clarify progress snapshot source of truth`
- `test(scope): add regression for failing tool run path`

In PR description include:

- problem statement
- root cause
- implemented fix
- test evidence
- any backward compatibility impact

## Backward Compatibility

This template is consumed by embedded copies in other repositories.

Avoid breaking changes unless necessary. If breaking behavior is required:

- document migration steps
- update `prd.json.example`
- add explicit test coverage
