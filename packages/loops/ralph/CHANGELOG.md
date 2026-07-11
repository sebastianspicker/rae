# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Unreleased)
- Claude CLI (`claude`) as alternative tool adapter via `--tool claude` or `RALPH_TOOL=claude`.
- `RALPH_CLAUDE_PERMISSION_MODE` env var for overriding Claude CLI permission mode.
- Tool-aware model defaults: `sonnet` for Claude, `gpt-5.3` for Codex (when no model specified).
- `build_prompt_without_policy()` for Claude adapter (INSTRUCTIONS.md injected via `--append-system-prompt`).
- `--version` flag prints `ralph <version>` and exits.
- `--reset-story <id>` command to reset a specific story to open state for re-processing.
- `--retry-failed` flag to reset all skipped stories to open state.
- `--no-color` flag and `NO_COLOR` env var support per https://no-color.org/.
- Color-coded terminal output: blue `[ralph]` prefix, green progress, yellow warnings, red errors.
- Run summary table displayed after processing stories (mode, processed, passed, failed, remaining, elapsed).
- `log_warn()` function for yellow warning messages.
- `log_progress()` now shows percentage alongside count.
- `CLAUDE.md` at project root for AI agent optimization.
- `scripts/run_tests.sh` test runner with filtering and summary output.
- Release-note categories for GitHub releases via `.github/release.yml`.
- README lifecycle state diagram covering normal and failure transitions.

### Changed (Unreleased)
- Consolidated `mark_story_passed()`/`mark_story_skipped()` via shared `_update_story_in_prd()` helper.
- Consolidated `capture_worktree_state_full()`/`capture_worktree_state_git()` via shared `_capture_worktree_from_entries()` helper.
- Extracted `PRD_STORY_BY_ID_GUARD` shared jq constant in `prd.sh`.
- `fail()` now uses shared `_RALPH_C_*` color constants instead of inline ANSI codes.
- Skills files (`skills/prd/SKILL.md`, `skills/ralph/SKILL.md`) translated from German to English.
- CI now uses `scripts/run_tests.sh` instead of inline test loop.
- `bootstrap_embedded.sh` now copies `CLAUDE.md` and `scripts/run_tests.sh`.
- Contributing guide updated with function naming conventions and test runner reference.

### Removed (Unreleased)
- `docs/` directory (configuration.md, operations.md, loop-flow.md stubs consolidated into README).
- `RELEASE_MANIFEST.md` (stale release-scope freeze).
- `progress.log.md` from git tracking (created on demand by scripts).
- `prd.json` from git tracking (added to `.gitignore`; use `prd.json.example` as starter).
- References to removed artifacts in core.sh, bootstrap_embedded.sh, AGENTS.md, CONTRIBUTING.md.

### Fixed (Unreleased)
- Stale documentation references in `core.sh` now point to `README.md`.
- `learnings.md` cleaned to template-only headers (removed development-specific entries).

## [0.1.0] - 2026-02-28

### Added (0.1.0)
- Deterministic Ralph loop template with lock-protected state mutation.
- PRD validation contract (`prd.schema.json`, `prd.validate.jq`) and runtime helpers.
- CLI read-only checks (`--status`, `--list-stories`, `--validate-config`, `--check`, `--doctor`).
- Import/export story state helpers and report aggregation support.
- Regression test suite and CI shellcheck + tests workflow.

### Security (0.1.0)
- Repository-confined atomic report writes and atomic PRD state persistence.
- Scope enforcement for `fixing` mode and runtime preflight checks.
