# Contributing

RAE is an alpha candidate. Public interfaces may change, and local verification
must not be presented as release evidence.

## Before changing code

- Read `README.md` and the nearest package documentation.
- Confirm which package owns the behavior.
- Inspect the relevant source, schema, tests, and current command output.
- Keep runtime state, local reports, credentials, and machine-specific
  files out of the public tree.
- Preserve unrelated working-tree changes.

Do not commit, push, publish, weaken a safety boundary, or add a production
dependency without maintainer authorization.

## Development setup

Use Node.js 24 or newer, npm, Git, CMake and a C compiler. Install the locked
workspaces and build the native bridge and TypeScript packages:

```sh
npm ci --ignore-scripts
npm run build
npm run rae -- doctor
```

On macOS, install the Xcode command-line tools. On Linux, install CMake, Make
and a C compiler.

`apps/platform/` is outside the root npm workspace. When that package or the
complete repository gate is in scope, install its lock separately:

```bash
npm ci --prefix apps/platform --ignore-scripts
```

## Change workflow

1. Reproduce the issue or establish the current behavior.
2. Make the smallest change that fixes the owning source.
3. Add or update tests for externally visible behavior and safety boundaries.
4. Run the narrowest relevant package check.
5. Run the repository verifier.
6. Review `git diff --check`, the complete diff, and untracked files.

Synchronized orchestration adapters must be changed through
`integrations/agent-adapters/content/templates/` and regenerated with:

```bash
npm --workspace @rae/agent-adapters run generate --
npm --workspace @rae/agent-adapters run generate -- --check
```

## Verification

See [TESTING.md](TESTING.md) for suite ownership, classifications, and focused
commands.

For a prepared offline checkout:

```bash
npm run verify -- --skip-install
```

Use `npm run verify --` when dependencies still need to be installed.
`--skip-docs` is a partial mode that omits the VitePress documentation build. It does not satisfy the release gate.

Use the focused command owned by the changed component. The complete command
matrix, including documentation-only checks and the distinction between
`npm test` and the repository gate, is maintained in [TESTING.md](TESTING.md).

Release candidates must satisfy the complete procedure in
[RELEASING.md](RELEASING.md), including:

```bash
npm run verify -- --release-candidate
```

Report every skipped or environment-blocked check. Do not generalize a focused
test result to the complete repository.

## Documentation

- Put tutorials, how-to guides, reference material, explanations, research, and
  governance pages in their corresponding `docs/` sections.
- Add the required frontmatter to pages under `docs/`.
- Keep command references aligned with `--help` and the owning implementation.
- Document current behavior and current limitations.
- Remove obsolete instructions instead of preserving them in maintained pages.
- Link empirical claims from `docs/reference/claims/claims-ledger.md` to their
  evidence.
- Regenerate CLI screenshots with
  `node scripts/dist/generate-docs-screenshots.js`; verify them with the same
  command plus `--check`.

Maintained executable files need a concise purpose header. Public or non-obvious
functions should document policy, safety, or lifecycle intent.

## Pull requests

A change is ready for review when:

- its scope and user-visible effect are clear
- tests cover the changed contract
- verification results and skipped checks are listed
- documentation and examples match the implementation
- synchronized files match their source templates
- the diff contains no local state, private data, or unrelated changes

Use [SECURITY.md](SECURITY.md) for private vulnerability reports. Use
[SUPPORT.md](SUPPORT.md) for usage questions.
