# Coauthor Trailer Cleaner

`coauthor-trailer-cleaner.sh` removes configured `Co-authored-by: Name <email>`
trailers from git commit history using `git-filter-repo`.

The cleaner accepts one or more co-author identities through CLI flags or a
JSON configuration file. Its default target is
`Cursor <cursoragent@cursor.com>`.

## Requirements

- Bash 5.3 or newer
- `git`
- `git-filter-repo`
- Python 3.14.6 or newer (`PYTHON_BIN` may select a compatible interpreter)

Install `git-filter-repo` on macOS:

```bash
brew install git-filter-repo
```

## Usage

```text
coauthor-trailer-cleaner.sh [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
coauthor-trailer-cleaner.sh [OPTIONS] --repos-file <file>
coauthor-trailer-cleaner.sh [OPTIONS] --config <config.json>
```

Key options:

- `--target "Name <email>"`: remove this co-author identity; repeatable
- `--push`: push rewritten history with an exact pre-rewrite upstream OID lease
- `--no-push`: rewrite locally only (default)
- `--dry-run`: show commands without changing history
- `--validate-only`: validate inputs only
- `--config <file>`: load defaults, targets, and optionally repos from JSON
- `--repos-file <file>`: load `url path` pairs or a JSON array of repos

Accepted repository URLs:

- `https://github.com/<user>/<repo>`
- `git@github.com:<user>/<repo>`
- `ssh://git@github.com/<user>/<repo>`

## Target Configuration

If no targets are provided, the script defaults to:

```json
[
  { "name": "Cursor", "email": "cursoragent@cursor.com" }
]
```

You can override that with repeated CLI flags:

```bash
./coauthor-trailer-cleaner.sh \
  --target "Pair Bot <pairbot@example.com>" \
  --target "Example Contributor <contributor@example.com>" \
  --no-push \
  https://github.com/user/repo /path/to/repo
```

or with a config file:

```json
{
  "defaults": {
    "noPush": true
  },
  "targets": [
    { "name": "Pair Bot", "email": "pairbot@example.com" },
    { "name": "Example Contributor", "email": "contributor@example.com" }
  ],
  "repos": [
    { "url": "https://github.com/user/repo", "path": "/path/to/repo" }
  ]
}
```

Schema: [coauthor-trailer-cleaner.schema.json](coauthor-trailer-cleaner.schema.json)
Example: [coauthor-trailer-cleaner.example.json](coauthor-trailer-cleaner.example.json)

## Safety Model

- rewrites history locally by default; remote mutation requires explicit `--push`
- rejects detached HEAD
- requires a clean worktree before rewrite
- requires an in-sync tracking branch before push rewrite
- captures the exact upstream commit before rewriting and pushes only with
  `--force-with-lease=<upstream-ref>:<captured-OID>`
- requires an absolute local path
- restores remote URLs after `git-filter-repo`
- creates a uniquely named local recovery branch for the current run
- filters only a private ref pinned to the captured original OID; the checked-out
  branch is promoted to the mapped rewritten OID only by an exact compare-and-swap
- revalidates the branch, HEAD, index, and worktree immediately before the
  recovery/rewrite boundary and before a remote update
- records the rewritten HEAD and refuses automatic rollback if the branch,
  recovery ref, worktree, or index changed during the transaction
- verifies that original and rewritten trees match, then rolls back only the
  branch ref with an exact old/new OID compare-and-swap; it never resets the
  worktree or index
- revalidates local state after a successful push before deleting recovery
  data; concurrent changes retain both recovery and rewritten transaction refs
- deletes the exact recovery and private transaction refs together in one
  atomic ref transaction that verifies their expected OIDs and the rewritten
  branch OID
- can retain the exact current-run recovery branch on `--backup-remote`; remote
  recovery branches are never wildcard-deleted
- supports `--validate-only` for a no-mutation preflight pass

Use an external backup or throwaway clone before rewriting shared history.

## Testing

Run the full test suite:

```bash
bash tests/run-tests.sh
```

Run a subset:

```bash
bash tests/run-tests.sh --filter custom_target
```

The suite covers URL parsing, target validation, callback behavior, config
loading, and full rewrite workflows.

## Files

- `coauthor-trailer-cleaner.sh`: main history rewrite CLI
- `lib/common.sh`: shared logging, target, JSON, and command helpers
- `lib/config.sh`: config and repository-list validation/loading
- `lib/git-workflow.sh`: repository validation, rewrite, leased push, and cleanup
- `lib/cli.sh`: argument parsing and top-level orchestration
- `coauthor-trailer-cleaner.schema.json`: JSON schema for config files
- `coauthor-trailer-cleaner.example.json`: example config
- `tests/`: unit and integration tests

## License

MIT. See [LICENSE](LICENSE).
