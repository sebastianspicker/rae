# Ralph Audit Agent Guide

This package is the standalone deterministic Ralph loop within RAE:

1. pick one open story by priority,
2. run one agent execution,
3. persist report atomically,
4. persist PRD status atomically.

## Runbook

```bash
MODE=audit   node dist/src/cli.js 20
MODE=linting node dist/src/cli.js 10
MODE=fixing  node dist/src/cli.js 10
```

Ralph is Codex-only. The TypeScript runtime requires Node.js >=24 and the
repository-built native filesystem bridge. The retained compatibility sources
require Bash >=5.3 and Python >=3.14.6 when their reference suite is run.

Quick checks: `--validate-prd`, `--validate-config`, `--status`, `--list-stories`, `--export-state`, `--import-state <file>`. Use `--dry-run N` to preview story runs without executing the tool. Use `--version` to print the version. Exit codes 0–6 (e.g. 2=PRD, 5=lock): see `README.md` CLI Reference.

## Contracts

- Story source of truth: `prd.json`
- Runtime policy: `INSTRUCTIONS.md`
- Validation: `prd.schema.json` + `prd.validate.jq`
- Runtime artifacts: `.runtime/`
- Derived progress snapshot: `progress.txt`
- Append-only long-term knowledge: `learnings.md`
- Companion authoring skills: `skills/prd/SKILL.md`, `skills/ralph/SKILL.md`

## Mandatory Safety Rules

- `audit` / `linting` stay read-only.
- `fixing` must remain story-scoped through the external mirror transaction.
- Exactly one `Created <path>.md ...` acceptance criterion per story.
- Report writes are atomic and repository-confined.
- PRD updates are atomic and lock-protected.
- PRD text must not contain hidden control/bidi characters.
- If search is enabled, reports must contain `## External References` with links and ISO dates.
- Security preflight can warn/fail on sensitive env var exposure (`RALPH_SECURITY_PREFLIGHT*`).
- Codex raw output is capped at 16 MiB and final reports at 2 MiB.
- Hardlinks, special files, nested repositories, and submodules are unsupported.

## Authoring Guidance

- Keep stories small and single-purpose.
- Prefer many small `steps[]` over a few large blocks.
- Keep `verification[]` explicit and evidence-focused.
- Use `out_of_scope[]` to block accidental scope creep.

See `prd.json.example` for a compact, schema-valid starter PRD.

## Operational Helpers

- `node dist/src/cli.js --export-state > backup.json` / `node dist/src/cli.js --import-state backup.json`: backup or restore story status (passes, skipped, report paths) to/from JSON.
- `node dist/src/cli.js --reset-story <id>`: reset a specific story to open state for re-processing.
- `node dist/src/cli.js --retry-failed`: reset all skipped stories to open state for retry.
- `node dist/src/helper-cli.js generate-progress`: regenerate `progress.txt` from `prd.json`.
- `node dist/src/helper-cli.js append-progress-entry`: append one concise event entry to `progress.log.md`.
- `node dist/src/helper-cli.js record-learning`: append reusable findings to `learnings.md`.
- `node dist/src/helper-cli.js sync-agents`: sync the latest `- Note:` into `AGENTS.md`.
- `node dist/src/helper-cli.js archive`: snapshot current run state into `archive/<timestamp>-<label>/`.
- `node dist/src/helper-cli.js bootstrap <target>`: create the self-contained embedded Node runtime.
- `npm test [-- filter]`: build and run the compiled Node suite with an optional filename filter.

The `.sh` and `.py` files are retained as reference-only compatibility
sources. They are excluded from generated embedded installations.
- Optional strict modes:
  - `RALPH_MODEL_PREFLIGHT=true`
  - `RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE=true`
  - `RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING=true`
  - `RALPH_SYNC_BRANCH_FROM_PRD=true`
