# Testing

RAE separates package checks from the repository gate. Run commands from the
repository root unless a different directory is stated.

## Repository gate

After installing the root and platform lockfiles, run:

```bash
npm run verify -- --skip-install
```

Without `--skip-install`, the verifier installs both lockfiles during the run.
`--skip-docs` omits the VitePress documentation build and is partial evidence. Release candidates must
use:

```bash
npm run verify -- --release-candidate
```

The repository gate validates public documentation and assets, architecture,
adapter synchronization, stale references, repository hygiene, strict TypeScript
checks, CLI smoke paths, root workspace builds, engine and operator behavior,
the separately installed platform, all development tools, and Ralph.
It also requires local Chrome or Chromium to verify the operator at desktop
and mobile viewport sizes. Browser verification uses temporary screenshots.

## Focused checks

| Scope | Command | Contract covered |
| --- | --- | --- |
| Engine public and workflow boundaries | `npm run test:engine` | Package exports, scheduler ordering, reader/writer exclusion, retries and crash recovery, bounded context, graph freshness and deep traversal, trace cursor integrity |
| Retained v1 engine behavior | `npm run test:engine-legacy` | Argument safety, provider event logs, operator CLI behavior |
| Loopback operator | `npm run test:operator` | Host, origin, bearer, route and process boundaries, summary pagination, static demo, incremental event rendering and focus preservation |
| Operator browser | `node apps/operator/dist/scripts/capture-docs-screenshots.js --check` | Connected Graph view, browser errors, exact desktop/mobile viewport sizes, page overflow and browser cleanup |
| Experimental platform | `npm run test:platform` | Hosted API and authorization, MemoryStore completion and fencing, paged streams, disconnects, long polls and listener shutdown |
| Development-tool executable protocol | `npm run test:dev-tools` | Compiled exports, health, valid and invalid JSON inputs |
| Profile transactions | `npm run test:profiles` | Disposable target install, backup restoration, injected rollback, symlink refusal |
| History transactions | `npm run test:history` | Isolated Git rewrite, exact leased local-bare push, rejected-push rollback, dirty preflight |
| PostgreSQL integration | `npm --prefix apps/platform run test:integration` | Requires disposable `RAE_PLATFORM_DATABASE_URL`; concurrent terminal reports, cancellation, lease contention and expiry, notifications and timeout replay |
| Ralph | `npm run test:ralph` | PRD, state, scope, process, and filesystem-transaction contracts |
| Package architecture | `node scripts/dist/check-architecture.js` | Workspace roots, import direction, public engine boundary |
| Adapter derivation | `npm --workspace @rae/agent-adapters run generate -- --check` | Manifest/template output synchronization |
| Maintained Markdown links | `node scripts/dist/check-markdown-links.js --root . --strict` | Relative targets and heading anchors |
| Repository documentation contract | `node scripts/dist/verify-repository.js` | Frontmatter, links, public files, assets, and source headers |

The strict Markdown link checker covers the root README, `CONTRIBUTING.md`, and
`docs/`. Package-local links are checked separately during a documentation
review.

## Build, lint, format, and type checks

`npm run build` compiles the native filesystem bridge and root TypeScript
packages in dependency order. Build the separately installed platform with
`npm --prefix apps/platform run build`. Production and test entrypoints use the
compiled JavaScript. Run `npm run typecheck` and `npm run lint` for strict
compilation and Biome checks. The docs configuration has a separate
`npm run typecheck:docs` command.

The operator's static mock is built with
`npm --workspace @rae/operator run build:demo`. `npm test` runs the package
test aggregate; `npm run verify -- --skip-install` also checks documentation,
contracts, native operations and CLI bootstrap behavior.

CI also builds all three development-tool images from the root lockfile and
runs the executable protocol fixtures with `RAE_TOOL_IMAGE_PREFIX=rae-tool-ci-`.
The PostgreSQL service is disposable and the integration suite owns an isolated
schema. Neither lane uses provider APIs. The local gate reports PostgreSQL tests
as skipped when no explicit disposable database URL is supplied.

The compiled run catalog benchmark accepts an explicit module and uses
100, 1,000 and 10,000 historical runs:

```sh
node scripts/dist/benchmarks/operator.js --module apps/operator/dist/lib/catalog.js --mode compiled
```

It records seven samples per size, public-result digests, latency, RSS, JavaScript
file-read bytes and parsing calls. Native and child-process I/O are outside those
counters. Timing from runs under different host load is observational. Graph tests
also check byte-bounded retention and 50,000-edge deep and wide topology.

## Documentation-only changes

For a Markdown-only change, run the two documentation checks, architecture
check when architectural claims changed, and `git diff --check`. The complete
application suite is required only when the repository contract or a
release-candidate procedure demands it. Record any skipped or blocked check
without presenting a focused result as whole-repository proof.
