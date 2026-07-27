# Ralph Audit Agent Guide

This repository is a reusable template for a deterministic Ralph loop:

1. pick one open story by priority,
2. run one agent execution,
3. persist report atomically,
4. persist PRD status atomically.

## Runbook

```bash
MODE=audit   ./ralph.sh 20
MODE=linting ./ralph.sh 10
MODE=fixing  ./ralph.sh 10
```

Ralph is Codex-only. It requires Bash >=5.3 and Python >=3.14.6.

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

- `./ralph.sh --export-state > backup.json` / `./ralph.sh --import-state backup.json`: backup or restore story status (passes, skipped, report paths) to/from JSON.
- `./ralph.sh --reset-story <id>`: reset a specific story to open state for re-processing.
- `./ralph.sh --retry-failed`: reset all skipped stories to open state for retry.
- `scripts/generate_progress.sh`: regenerate `progress.txt` from `prd.json`.
- `scripts/run_tests.sh [filter]`: run test suite with optional filter and summary output.
- `scripts/append_progress_entry.sh`: append one concise event entry to `progress.log.md`.
- `scripts/record_learning.sh`: append reusable findings to `learnings.md`.
- `scripts/sync_agents_from_learnings.sh`: sync latest `- Note:` from `learnings.md` into `AGENTS.md`.
- `scripts/archive_run_state.sh`: snapshot current run state into `archive/<timestamp>-<label>/`.
- `scripts/bootstrap_embedded.sh`: copy this template to `.claude/ralph-audit` in another repo.
- Optional strict modes:
  - `RALPH_MODEL_PREFLIGHT=true`
  - `RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE=true`
  - `RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING=true`
  - `RALPH_SYNC_BRANCH_FROM_PRD=true`
