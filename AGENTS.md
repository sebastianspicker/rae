# Repository Agent Guide

This file defines the repository-wide contract for automated contributors.
Package-local `AGENTS.md` files may add stricter runtime or verification rules.

## Working rules

- Read `README.md`, `CONTRIBUTING.md`, and the nearest package documentation
  before changing behavior.
- Declare the intended scope and verification evidence for non-trivial work.
- Preserve unrelated working-tree changes and keep runtime state out
  of the public tree.
- Prefer the smallest adequate execution surface: a focused tool before Ralph,
  and Ralph before the orchestration pipeline.
- Treat plans, model output, and self-reports as proposals. Source contracts,
  tests, schemas, and repository-owned evaluators decide correctness.
- Never commit, push, publish, or weaken a safety boundary without explicit
  maintainer authorization.

## Documentation and evidence

- Give maintained executable files a concise purpose header; document public
  or non-obvious functions where policy, safety, or lifecycle intent matters.
- Keep tutorials, how-to guides, reference material, explanations, research,
  and governance documents in their corresponding `docs/` sections.
- Label experimental behavior and screenshots accurately. Do not present a
  concept, deterministic fixture, or local partial run as production evidence.
- Record reusable public claims in
  `docs/reference/claims/claims-ledger.md` with their evidence source.

## Verification

Run the narrowest relevant checks while iterating, then the documented umbrella
gate before release:

```bash
./scripts/verify.sh --skip-install
```

`--skip-mkdocs` is a partial mode for environments without the pinned docs
toolchain. Release candidates must use the complete procedure in
`RELEASING.md` and satisfy `./scripts/verify.sh --release-candidate`.

## Security boundary

Keep autonomous changes inside their approved worktree and plan-owned paths.
Evaluator fixtures, judge code, policies, Git history, remotes, secrets, and
publication surfaces remain outside model-controlled mutation. Follow
`SECURITY.md` for private vulnerability reporting.
