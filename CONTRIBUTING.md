# Contributing

RAE is an alpha candidate. Public interfaces may change, and local verification
must not be presented as release evidence.

## Before changing code

- Read `AGENTS.md`, `README.md`, and the nearest package documentation.
- Confirm which package owns the behavior.
- Inspect the relevant source, schema, tests, and current command output.
- Keep runtime state, local reports, credentials, and machine-specific
  files out of the public tree.
- Preserve unrelated working-tree changes.

Do not commit, push, publish, weaken a safety boundary, or add a production
dependency without maintainer authorization.

## Development setup

Required versions:

- GNU Bash 5.3 or newer
- Python 3.14.6 or newer
- Node.js `>=20.19.0 <21`, `>=22.12.0 <23`, or `>=24.0.0`

Create the Python environment and install the locked dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements-ci.txt
npm --prefix packages/orchestration ci
./scripts/rae.sh doctor
```

On macOS with Python 3.14, use `requirements-macos.txt`. It selects the pinned
Watchdog source archive and requires the Xcode command-line tools.

## Change workflow

1. Reproduce the issue or establish the current behavior.
2. Make the smallest change that fixes the owning source.
3. Add or update tests for externally visible behavior and safety boundaries.
4. Run the narrowest relevant package check.
5. Run the repository verifier.
6. Review `git diff --check`, the complete diff, and untracked files.

Synchronized orchestration adapters must be changed through
`packages/orchestration/adapters/templates/` and regenerated with:

```bash
python3 packages/orchestration/scripts/adapters/generate_adapters.py
python3 packages/orchestration/scripts/adapters/generate_adapters.py --check
```

## Verification

See [TESTING.md](TESTING.md) for suite ownership, classifications, and focused
commands.

For a prepared offline checkout:

```bash
./scripts/verify.sh --skip-install
```

Use `./scripts/verify.sh` when dependencies still need to be installed.
`--skip-mkdocs` is a partial mode for environments without the pinned MkDocs
toolchain. It does not satisfy the release gate.

Useful focused checks:

```bash
npm --prefix packages/orchestration run test:operator
npm --prefix packages/orchestration run test:runner
bash packages/loops/ralph/scripts/run_tests.sh
python3 -B scripts/verify_repo.py --skip-mkdocs
```

Release candidates must satisfy the complete procedure in
[RELEASING.md](RELEASING.md), including:

```bash
./scripts/verify.sh --release-candidate
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
  `python3 scripts/generate_docs_screenshots.py`; verify them with the same
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
