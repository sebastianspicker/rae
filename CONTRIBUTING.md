# Contributing

## Principles

- keep changes surgical
- document assumptions explicitly
- prefer evaluation over intuition
- do not merge empirical claims without evidence links
- keep docs modes separate: tutorial, how-to, reference, explanation, research, governance

## Required checks

Run:

```bash
./scripts/verify.sh
```

This currently includes umbrella verification plus:

- orchestration-package verification
- Ralph package verification
- co-author trailer cleaner tests

## Documentation rules

- every docs page under `docs/` needs frontmatter
- reference and research pages must link their source of truth
- benchmark result pages must include version and run metadata
- major conceptual claims must be registered in `docs/reference/claims/claims-ledger.md`

## Public repo hygiene

- do not commit generated run state, local benchmark outputs, caches, or editor junk
- keep future-facing directory scaffolds out of the public tree unless they
  already contain a concrete public artifact
- keep package-local operator docs only when the package runtime or tests
  actually depend on them
- if a surface is only planned, describe the boundary accurately instead of
  implying shipped capability

## Package imports

- keep imported modules self-contained first
- prefer minimal path adaptation over redesign during import
- do larger cross-module unification only after imported verification is green
- keep bash-based imported modules runnable from their own package root

## Branching

- `dev` is the active branch
- keep initial public scaffold history concise
