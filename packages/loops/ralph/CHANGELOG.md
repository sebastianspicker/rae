# Changelog

## [0.3.0] - 2026-07-16

### Changed

- Require Bash 5.3+ and Python 3.14.6+.
- Make Codex CLI the only execution backend.
- Resolve Codex to an absolute executable outside the repository and launch it
  with an exact environment allowlist.
- Supervise Codex with a positive deadline, 15-second graceful shutdown, and
  16 MiB raw-output / 2 MiB report limits.
- Run fixing providers in an external workspace with an immutable baseline,
  identity-bound metadata outside provider-writable temp roots, per-entry
  atomic quarantine and no-clobber installation, retained conflict evidence,
  and path-limited crash recovery with the same no-clobber transitions.
- Check report confinement before creating directories and before replacement.
- Keep `.claude/ralph-audit` as the only embedded discovery location.

### Removed

- Claude backend and documentation.
- `--tool`, `RALPH_TOOL`, tool aliases, `CODEX_TIMEOUT_SECONDS`,
  `RALPH_CAPTURE_CODEX_OUTPUT`, `--skip-security-check`, `CODEX.md` discovery,
  `.codex/ralph-audit` discovery, and `RALPH_FIXING_STATE_METHOD`.

## [0.1.0] - 2026-02-28

- Initial deterministic Ralph loop template.
