# Ralph audit loop

Ralph is a story-driven repository loop with three modes:

- `audit` performs read-only repository inspection
- `linting` performs read-only static analysis
- `fixing` applies one story's changes through a recoverable filesystem
  transaction

Stories and acceptance criteria are read from `prd.json`. The runtime uses the
Codex CLI for story execution and validates its own configuration, report
paths, state transitions, deadlines, output limits, and fixing transactions.

## Requirements

- Node.js 24 or newer and npm for the TypeScript runtime
- the repository-built `@rae/fs-bridge` native module
- Codex CLI resolved to an absolute executable outside the target repository
- optional `git` for root discovery and branch synchronization

## Setup

For package development, copy the example PRD:

```bash
cp prd.json.example prd.json
npm run build
node dist/src/cli.js --validate-prd
node dist/src/cli.js --check
```

`prd.json` is local runtime state and is ignored by Git. Embedded installations
use:

```bash
node dist/src/helper-cli.js bootstrap /path/to/target-repository
```

The canonical embedded path is `.claude/ralph-audit/`. The bootstrap command
copies a self-contained Node runtime and native bridge, refuses symlinked or
invalid destination parents, and verifies the copied payload. Add
`--with-tests` to include the compiled Node suite.

## Usage

Process up to a fixed number of stories:

```bash
node dist/src/cli.js --mode audit 20
node dist/src/cli.js --mode linting 10
node dist/src/cli.js --mode fixing 5
```

`MODE=audit`, `MODE=linting`, or `MODE=fixing` is equivalent to `--mode`.
When the story count is omitted, Ralph processes the remaining open stories up
to `defaults.max_stories_default`.

Common read-only commands:

```bash
node dist/src/cli.js --validate-prd
node dist/src/cli.js --validate-config
node dist/src/cli.js --check
node dist/src/cli.js --doctor
node dist/src/cli.js --status
node dist/src/cli.js --list-stories
node dist/src/cli.js --dry-run 3
```

State-management commands:

```bash
node dist/src/cli.js --export-state > state.json
node dist/src/cli.js --import-state state.json
node dist/src/cli.js --reset-story FIX-001
node dist/src/cli.js --retry-failed
node dist/src/cli.js --aggregate-reports
```

Run `node dist/src/cli.js --help` for the complete command syntax.

The process exit codes are stable: `0` success, `1` configuration or general
failure, `2` invalid PRD or state input, `3` scope or confinement failure, `4`
provider failure, `5` lock failure, and `6` security-preflight failure.

## Contracts

- `prd.json` is the story source of truth.
- Stories are selected by numeric `priority`, then `id`.
- Exactly one `Created <path>.md ...` acceptance criterion selects the report
  path.
- The report path is validated before directory creation and again before
  replacement.
- Strict mode requires the path to remain under `defaults.report_dir`.
- `INSTRUCTIONS.md` supplies the task rules used for every story.
- Optional `learnings.md` updates can be required after successful fixing
  stories.

See `prd.json.example` and `prd.schema.json` for the supported fields.

## Configuration

Command flags override environment values where both are available.

Execution:

- `MODE`: `audit`, `linting`, or `fixing`
- `RALPH_REPO_ROOT`: explicit target root
- `RALPH_MODEL`: model identifier; default `gpt-5.3`
- `RALPH_REASONING_EFFORT`: reasoning setting; default `high`
- `RALPH_TIMEOUT_SECONDS`: positive per-story deadline; default `900`
- `RALPH_MAX_ATTEMPTS_PER_STORY`: transient-failure attempt count; default `1`
- `RALPH_SKIP_AFTER_FAILURES`: persistent-failure threshold; default `0`
- `RALPH_SEARCH_ENABLED_BY_DEFAULT`: enable search; default `false`
- `RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH`: require an External References
  section when search is enabled; default `true`
- `RALPH_MODEL_PREFLIGHT`: run a lightweight provider check; default `false`

Safety and state:

- `RALPH_SECURITY_PREFLIGHT`: scan for sensitive environment variables;
  default `true`
- `RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK`: fail when that scan finds a risk;
  default `false`
- `RALPH_STRICT_REPORT_DIR`: confine reports to `defaults.report_dir`; default
  `true`
- `RALPH_TRANSACTION_METADATA_ROOT`: absolute private directory for fixing
  journals and baselines; default `~/.local/state/ralph-fs-transactions`
- `RALPH_STALE_LOCK_NO_PID_SECONDS`: age before a lock without a valid process
  ID is considered stale; default `30`
- `RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE`: archive state when the PRD project
  changes; default `false`
- `RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING`: require a learning entry after a
  successful fixing story; default `false`
- `RALPH_SYNC_BRANCH_FROM_PRD`: synchronize the current branch from the PRD;
  default `false`
- `RALPH_AUTO_PROGRESS_LOG_APPEND`: append completion entries to
  `progress.log.md`; default `true`
- `RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS`: synchronize repository instructions
  from the latest learning after fixing; default `false`
- `RALPH_AUTO_PROGRESS_REFRESH`: refresh derived progress state; default `true`

Output:

- `RALPH_CAPTURE_TOOL_OUTPUT`: persist redacted provider output; default `false`
- `RALPH_VERBOSITY`: `normal`, `quiet`, or `verbose`
- `RALPH_OUTPUT_FORMAT`: `text` or `json`
- `RALPH_STATUS_FORMAT`: `full`, `compact`, or `json`
- `RALPH_LIST_STORIES_FORMAT`: `full`, `ids`, `id+title`, or `json`

Boolean settings accept `true` or `false`. Use `--json`, `--status-format`, and
`--list-stories-format` for per-command machine-readable output.

## Fixing transaction

Fixing mode creates an external writable workspace and a separate immutable
baseline. Private identity, journal, quarantine, and recovery data remain under
`RALPH_TRANSACTION_METADATA_ROOT`, outside provider-writable workspace and
temporary roots.

On success, Ralph stages the desired entries. Existing entries are moved to a
journaled quarantine with a native no-clobber rename, checked against the
baseline, and replaced with another no-clobber rename. New entries use the
no-clobber install directly. Read-only directory roots use journaled hidden
staging and backup siblings so macOS can perform same-parent renames without
changing the live directory mode. A concurrent entry at the destination is
preserved.

Recovery validates the repository and runtime identities before applying the
same journaled protocol. Multi-path promotion is recoverable but is not
globally atomic. macOS and Linux provide the required native no-clobber
primitive; other platforms fail closed. Hard links, special files, nested
repositories, and submodules are rejected.

## Runtime Files

- `.runtime/events.log`: lifecycle events
- `.runtime/run.log`: optional redacted provider output
- `.runtime/.run.lock`: single-run lock
- `.runtime/.fixing-quarantine/`: package-local failure evidence
- `progress.log.md`: optional local completion log
- `~/.local/state/ralph-fs-transactions/`: default private fixing journals,
  pointers, quarantines, and immutable baselines

These files are local state and must not be committed.

## Deadlines and output limits

At the per-story deadline, Ralph sends an interrupt, waits 15 seconds, then
kills the process group and records status `124`. Raw provider output is capped
at 16 MiB and the final report at 2 MiB. Overflow uses internal status `125`,
is returned as Ralph exit code `4`, and does not mark the story successful.
Cleanup waits for the process group even when the parent exits first. If group
absence cannot be confirmed after the hard kill, internal status `126` stops
retries, reports uncertain containment, and retains the attempt directory.
Provider outputs use no-follow descriptor reads and byte limits; invalid report
paths are rejected before their contents are read.
PRDs require valid UTF-8. Hidden control and bidirectional characters are
rejected in decoded JSON strings, including characters written as JSON escapes.
SIGINT and SIGTERM use the same awaited cleanup before releasing the run lock;
they stop retries and story promotion, then exit with status `130` or `143`.

## Testing

Run the package suite:

```bash
npm test
```

The repository umbrella gate also runs this package:

```bash
npm --prefix ../.. run verify -- --skip-install
```

## Troubleshooting

- If root discovery is ambiguous, set `RALPH_REPO_ROOT` to the canonical target
  directory.
- If `--check` reports an invalid story, compare `prd.json` with
  `prd.json.example` and the JSON schema.
- If report confinement fails, use one `Created <path>.md ...` criterion below
  `defaults.report_dir`.
- If a lock has no live process ID, wait for
  `RALPH_STALE_LOCK_NO_PID_SECONDS` or inspect the lock with `--doctor`.
- If a fixing run stops during promotion, preserve the private transaction
  directory and run the documented recovery path before retrying the story.
- If provider output is needed for diagnosis, enable
  `RALPH_CAPTURE_TOOL_OUTPUT=true`; review `.runtime/run.log` for private data
  before sharing it.

## Security considerations

Ralph launches the provider with an empty environment plus a fixed allowlist.
Unrelated credential variables are not inherited. Audit and linting use a
read-only provider sandbox. Fixing uses an external workspace plus the
transaction described above.

Do not include secrets in `prd.json`, `INSTRUCTIONS.md`, reports, or captured
output. Keep transaction state private. See [`SECURITY.md`](SECURITY.md) and
the repository [`SECURITY.md`](../../SECURITY.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for package checks and the repository
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) for the full contribution
workflow.
