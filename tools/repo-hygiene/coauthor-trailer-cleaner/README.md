# Coauthor Trailer Cleaner

`coauthor-trailer-cleaner.sh` removes configured `Co-authored-by: Name <email>`
trailers from git commit history using `git-filter-repo`.

This module is the generalized public umbrella import of an earlier
Cursor-focused cleaner. The default target still matches the
historical Cursor trailer for backward compatibility, but the cleaner now
accepts arbitrary co-author identities through CLI flags or config.

## Requirements

- `bash`
- `git`
- `git-filter-repo`
- `python3`

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
- `--push`: explicitly push rewritten history to the remote
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
  --target "Review Agent <review@example.com>" \
  --no-push \
  https://github.com/user/repo /path/to/repo
```

or with a config file:

```json
{
  "defaults": {
    "noPush": true,
    "forcePush": true
  },
  "targets": [
    { "name": "Pair Bot", "email": "pairbot@example.com" },
    { "name": "Review Agent", "email": "review@example.com" }
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
- requires an absolute local path
- restores remote URLs after `git-filter-repo`
- can create backup branches before rewrite
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
- `coauthor-trailer-cleaner.schema.json`: JSON schema for config files
- `coauthor-trailer-cleaner.example.json`: example config
- `tests/`: unit and integration tests

## License

MIT. See [LICENSE](LICENSE).
