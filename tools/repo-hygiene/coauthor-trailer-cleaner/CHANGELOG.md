# Changelog

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-07-16

### Changed
- Removed `--force-push`, `--no-force-push`, and `defaults.forcePush`.
- Remote rewrites now always use an exact
  `--force-with-lease=<upstream-ref>:<pre-rewrite-upstream-OID>` guard.
- Split the implementation into directly sourced semantic modules instead of
  extracting functions through `sed` and `eval` in tests.

### Security
- Remote recovery branches are retained and are never wildcard-deleted.
- Cleanup deletes only the exact current-run local recovery branch after
  successful trailer verification and verifies that the branch still points at
  the captured pre-rewrite commit.
- The rewrite transaction now derives the rewritten tip from git-filter-repo's
  commit map, pushes that exact OID, and revalidates state before and after the
  remote update.
- `git-filter-repo` operates only on a private ref pinned to the captured
  original OID. The checked-out branch is promoted separately with an exact
  old/new OID compare-and-swap, so concurrent branch commits are preserved.
- Failed pushes roll back only the branch ref, using an exact compare-and-swap
  after verifying identical trees. The cleaner never resets the worktree or
  index; concurrent changes retain recovery data for manual inspection.
- Successful cleanup atomically verifies the rewritten branch and
  compare-deletes both the recovery and private transaction refs.

### Runtime
- Enforces Bash 5.3+ and Python 3.14.6+ and resolves all Python execution
  through `PYTHON_BIN`.

## [2.0.0] - 2026-04-12

### Changed (2.0.0)
- Generalized the tool from a Cursor-only history rewrite into a configurable
  co-author trailer cleaner
- Renamed the public command surface to `coauthor-trailer-cleaner.sh`
- Added repeatable `--target "Name <email>"` CLI overrides
- Added top-level `targets` support in config files and schema
- Updated tests to cover custom targets in addition to the legacy Cursor default

## [1.3.2] - 2026-03-22

### Fixed
- Fixed the `grep -P` portability issue in the test suite by using Python-based
  check for macOS compatibility (ISSUE-016)
- Fixed unquoted `$TARGET_REMOTE` in for-each-ref glob pattern (ISSUE-018)
- Fixed misleading "no trailers" message on empty repos with no commits (ISSUE-019)
- Removed redundant newline sanitization in `_json_extract` Python code,
  now handled by upstream `validate_config_json` (ISSUE-020)

### Improved
- CI test job now depends on the lint job (`needs: lint`), so tests run only after
  linting passes (ISSUE-017)
- Documented `--option=value` syntax limitation in usage text (ISSUE-021)

## [1.3.1] - 2026-03-22

### Fixed (1.3.1)
- Fixed backup branch name collisions when same repo processed twice in batch
  by adding a counter to the branch name (ISSUE-013)
- Added `backupRemote` pattern validation to `validate_config_json`, consistent
  with schema and CLI validation (ISSUE-014)
- Updated input line references (ISSUE-015)

### Added (1.3.1)
- 9 new tests: detached HEAD, relative path, --repos-file (plaintext + JSON),
  --backup-remote validation, config path validation, URL trailing slash
- Test suite now has 37 tests (up from 28)

## [1.3.0] - 2026-03-22

### Fixed (1.3.0)
- Fixed exit code capture bug in `check_cursor_trailers()` where `$?` in the else
  branch did not reflect the pipeline's actual exit code (ISSUE-001)
- Fixed dead code and fragile error handling in `do_push_phase()` where `|| true`
  masked `resolve_target_remote` failures (ISSUE-002)
- Fixed `run_cmd` silently swallowing stderr in quiet mode (ISSUE-005)
- Fixed `|| true` in verbose branch listing masking unrelated errors (ISSUE-009)

### Added (1.3.0)
- Runtime config validation via `validate_config_json()` using pure Python stdlib
- Test suite: 17 unit tests, 11 integration tests (28 total)
- CI job for integration tests with git-filter-repo
- `CLAUDE.md` with project conventions and development guidelines
- `CHANGELOG.md`
- Warning when remote backup file is empty before filter-repo

### Improved (1.3.0)
- JSON schema: `additionalProperties: false`, URL pattern validation, path pattern,
  `minLength` constraints, property descriptions
- Error handling: replaced fragile `|| true` patterns with explicit exit code capture
- Documented MESSAGE_CALLBACK regex components
- README: added Testing, Contributing sections; expanded Release Process
- File-level header comment with function contract summary
- Two-pass CLI parsing documented

## [1.2.1] - 2026-03-13

### Fixed (1.2.1)
- Hardened rewrite flow and improved safety checks

### Added (1.2.1)
- CI workflow with ShellCheck, syntax checks, JSON validation
- Dependabot for GitHub Actions updates
- CODEOWNERS and security policy
- How-it-works and lifecycle Mermaid diagrams

## [1.0.0] - 2026-03-13

### Added (1.0.0)
- Initial release: remove Cursor co-author trailers from git history
- Single-repo and batch processing support
- JSON config with defaults and repos array
- Dry-run, validate-only, and no-push modes
- Backup branch creation and remote restoration
