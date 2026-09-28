# Coauthor Trailer Cleaner Agent Guide

## Scope

This file applies to the standalone Git history-rewrite utility in this
directory. Its normal local action rewrites commit history; `--push` can
rewrite a remote.

## Safety contract

- Never run the cleaner against a real repository or use `--push` unless the
  user explicitly requests that exact mutation and target.
- Use `--validate-only` or `--dry-run` for read-only inspection. Use a
  disposable clone for mutation tests.
- Preserve the clean-worktree, attached-HEAD, tracking, upstream-OID,
  compare-and-swap, exact force-with-lease, and recovery-ref checks.
- Keep local rewrite as the default. Remote mutation must remain an explicit
  option and must never broaden to wildcard ref deletion.
- Preserve concurrent-change detection and leave recovery evidence intact when
  automatic cleanup or rollback is unsafe.
- Keep examples free of real personal identities, credentials, and private
  repository locations.

## Verification

```bash
npm run rae -- hygiene coauthor-cleaner --help
```

Run mutation scenarios only in isolated temporary repositories. Update
`README.md` and `CHANGELOG.md` when the CLI, target matching, recovery, or
remote rewrite contract changes.
