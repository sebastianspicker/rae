# Ralph Audit Loop

Pure Bash framework (~3,500 lines) for deterministic, story-driven repository auditing, linting, and fixing. MIT licensed.

## Architecture

Entry point: `ralph.sh` → module loading → `main()` flow.

```
ralph.sh                  # Entry point, globals, main loop
lib/ralph/
  compat.sh               # Cross-platform compatibility (mktemp, date)
  core.sh                 # Logging, errors, exit codes, utilities, color support
  config.sh               # Path resolution, PRD defaults, branch sync, locking
  config_parse.sh         # CLI argument parsing, runtime config validation
  validate_prd.sh         # PRD schema + jq filter validation engine
  preflight.sh            # Security and model preflight checks
  lock.sh                 # Directory-based run lock (PID-tracked, stale detection)
  tool.sh                 # Tool adapter selection and validation (claude, codex)
  prd.sh                  # Story extraction, scope/path matching, jq constants
  status.sh               # --status, --check, --doctor output formatting
  prompt.sh               # Story-to-prompt template generation
  aggregate.sh            # Report aggregation across stories
  state_io.sh             # --export-state / --import-state JSON serialization
  runner.sh               # Story processing loop, attempt management
  runner_scope.sh         # Worktree state capture, diff, scope enforcement
  runner_persist.sh        # Report writing, PRD updates, progress, failure handling
```

## Key Conventions

- **Global variable registry**: ~50 globals declared at top of `ralph.sh`, initialized before module loading.
- **Atomic file operations**: Always `mktemp` + write + `mv` for state files (PRD, reports, failures).
- **Function naming**: public (`log`, `fail`), internal (`_update_story_in_prd`), compat (`ralph_mktemp_init`).
- **jq-driven JSON**: PRD manipulation uses jq with shared filter constants in `prd.sh` (`PRD_OPEN_STORY_SELECT`, `PRD_STORY_BY_ID_GUARD`).
- **Exit codes**: Defined in `core.sh` — 0=success, 1=general, 2=PRD, 3=scope, 4=tool, 5=lock, 6=security.
- **Color output**: Uses `_RALPH_C_*` constants in `core.sh`, respects `NO_COLOR` env and `--no-color` flag.

## Running Tests

```bash
# All tests
bash scripts/run_tests.sh

# Filtered
bash scripts/run_tests.sh scope        # runs tests matching *scope*
bash scripts/run_tests.sh version      # runs tests matching *version*
```

Each test is a standalone script in `tests/` using `tests/lib/test_helpers.sh`. Tests create temp directories, set up fixtures, and clean up after themselves.

## Running Shellcheck

```bash
shellcheck -x ralph.sh lib/ralph/*.sh scripts/*.sh scripts/lib/*.sh tests/*.sh tests/lib/*.sh
```

## Running Ralph

```bash
./ralph.sh --version              # Show version
./ralph.sh --check                # Read-only health check
./ralph.sh --doctor               # Diagnostics
./ralph.sh --status               # Show current state
./ralph.sh --help                 # Full usage

MODE=audit ./ralph.sh 5           # Process 5 audit stories (default: claude)
RALPH_TOOL=codex MODE=audit ./ralph.sh 5   # Process 5 audit stories via Codex CLI
./ralph.sh --mode fixing 10               # Process 10 fixing stories via Claude
./ralph.sh --reset-story AUDIT-001  # Reset a story for re-processing
./ralph.sh --retry-failed         # Reset all skipped stories
```

## Rules

- **No new dependencies**: Pure Bash + jq + standard POSIX tools. No Python, Node, etc.
- **Backward compatibility**: Embedded consumers (`.claude/ralph-audit/`) depend on CLI, exit codes, and PRD schema.
- **Test every behavior change**: Add or update tests in `tests/ralph_*_test.sh` for any functional change.
- **Atomic writes**: Never write directly to PRD or state files; use mktemp+mv pattern.
- **Schema alignment**: Any PRD field changes must update `prd.schema.json`, `prd.validate.jq`, and relevant tests.
