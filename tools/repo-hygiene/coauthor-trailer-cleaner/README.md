# Coauthor Trailer Cleaner

The compiled TypeScript cleaner removes configured `Co-authored-by: Name <email>`
trailers using Git object plumbing. It preserves trees, ordered parent topology
and byte-exact identity metadata. Message transformation preserves the existing
trailer matching and repeated-blank-line cleanup without decoding message bytes.

The cleaner accepts one or more co-author identities through CLI flags or a
JSON configuration file. Its default target is
`Cursor <cursoragent@cursor.com>`.

## Requirements

- Node.js 24 or newer
- Git with the `reference-transaction` hook capability

Build from the repository root:

```text
npm --prefix tools/repo-hygiene/coauthor-trailer-cleaner run build
```

The cleaner probes Git hook support before changing refs and fails closed if
the attachment guard is unavailable.

## Usage

```text
npm run rae -- hygiene coauthor-cleaner [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
npm run rae -- hygiene coauthor-cleaner [OPTIONS] --repos-file <file>
npm run rae -- hygiene coauthor-cleaner [OPTIONS] --config <config.json>
```

Key options:

- `--target "Name <email>"`: remove this co-author identity; repeatable
- `--push`: push rewritten history with an exact pre-rewrite upstream OID lease
- `--no-push`: rewrite locally only (default)
- `--dry-run`: inspect the selected repository without changing history
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
npm run rae -- hygiene coauthor-cleaner \
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
- leaves remote configuration unchanged
- creates a uniquely named local recovery branch for the current run
- transforms raw commit objects and keeps a private ref pinned to the captured
  original OID; the branch is promoted only by an exact compare-and-swap
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

A private prepared-phase Git hook checks the captured HEAD attachment while
Git holds the ref locks. Existing reference-transaction hooks still receive
their phases and input. A concurrent branch switch aborts promotion, rollback
or cleanup and retains recovery refs.

Signatures on changed commits cannot remain valid. The cleaner strips those
invalid signatures, reports their count, and leaves signatures on unchanged
objects intact. Unrelated branches and tags retain their original objects.

Use an external backup or throwaway clone before rewriting shared history.

## Verification smoke path

```bash
npm run rae -- hygiene coauthor-cleaner --help
```

## Files

- `src/cli.ts`: argument parsing, configuration validation and orchestration
- `src/objects.ts`: byte-preserving message and parent transformation
- `src/git.ts`: object plumbing, leased pushes and recovery transactions
- `src/ref-guard.ts`: prepared-phase HEAD attachment guard
- `coauthor-trailer-cleaner.schema.json`: JSON schema for config files
- `coauthor-trailer-cleaner.example.json`: example config

## License

MIT. See [LICENSE](LICENSE).

Identity deduplication uses the vendored Unicode 16 full case-folding table to
preserve the former Python 3.14 behavior. The first spelling of each identity
still controls raw-byte trailer matching. The table and its license are in
`data/`; its checksum is verified when the CLI loads.
