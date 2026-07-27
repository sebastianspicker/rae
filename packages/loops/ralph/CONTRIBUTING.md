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

- Bash 5.3 or newer
- Python 3.14.6 or newer
- `jq`
- `mktemp`
- `shellcheck`

Optional but useful:

- `git`
- `codex` (needed only for execution flows, not for most tests)

## Development Rules

- Use Bash 5.3 features where they make safety boundaries explicit.
- Prefer explicit failure handling over silent fallback.
- Avoid broad refactors mixed with behavior changes.
- Preserve deterministic behavior of the story loop.
- Keep security-sensitive behavior conservative by default.

## CI

On push and pull requests, GitHub Actions runs shellcheck and the full test suite. See [../../../.github/workflows/ci.yml](../../../.github/workflows/ci.yml).

## Testing Requirements

Before opening a PR:

1. Run shell linting:

```bash
shellcheck -x ralph.sh scripts/*.sh lib/ralph/*.sh tests/*.sh tests/lib/*.sh
```

2. Run full regression suite:

```bash
bash scripts/run_tests.sh
```

3. If behavior changes, add or update tests in `tests/`.

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

## Function Naming Conventions

- Public functions: no prefix (`log`, `fail`, `mark_story_passed`)
- Internal or shared helpers: underscore prefix (`_update_story_in_prd`)
- Compatibility and initialization functions: `ralph_` prefix
  (`ralph_mktemp_init`, `ralph_iso_utc`)

## Backward Compatibility

This template is consumed by embedded copies in other repositories.

Avoid breaking changes unless necessary. If breaking behavior is required:

- document migration steps
- update `prd.json.example`
- add explicit test coverage
