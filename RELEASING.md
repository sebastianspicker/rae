# Releasing RAE

`v0.1.0-alpha.1` is the proposed first public alpha tag. The supported alpha
artifact is the tagged source tree; RAE does not currently publish a package,
container, hosted service, or stable API.

## 1. Freeze the candidate

- Start from a refreshed `main` and create a dedicated release branch.
- Apply only the reviewed alpha diff; do not carry ignored caches, agent state,
  local ledgers, or runtime output.
- Confirm `CITATION.cff`, [CHANGELOG.md](CHANGELOG.md), and
  [RELEASE_NOTES.md](RELEASE_NOTES.md), and
  [RELEASE_STATUS.md](RELEASE_STATUS.md) name the same version.
- Regenerate and verify the public CLI captures:

```bash
node scripts/dist/generate-docs-screenshots.js
node scripts/dist/generate-docs-screenshots.js --check
```

## 2. Install declared dependencies

Use Node.js 24 or newer with npm, Git, CMake and a C compiler. Install both
lockfiles and compile all runtime entrypoints:

```sh
npm ci --ignore-scripts
npm ci --prefix apps/platform --ignore-scripts
npm run build
npm --prefix apps/platform run build
```

`npm run rae -- doctor` verifies the Node baseline and compiled entrypoints.

## 3. Run release gates

```bash
npm run rae -- doctor
npm run rae -- agent doctor
npm run verify -- --release-candidate
git diff --check
git status --short
```

The release gate is green only when:

- the VitePress build runs;
- the Git worktree is clean and every release-essential file is tracked;
- all tooling, engine, operator, platform, Ralph, profile, and history suites pass;
- deterministic screenshots are current;
- the candidate worktree contains no unexpected changes;
- GitHub CI, CodeQL, and Scorecard complete on the candidate commit.

Partial verifier modes are useful for development but are not release proof.

## 4. Review the public source tree

Inspect a Git-derived export rather than the live checkout:

```bash
git archive --format=tar.gz \
  --prefix=rae-0.1.0-alpha.1/ \
  --output=/tmp/rae-0.1.0-alpha.1.tar.gz \
  HEAD
tar -tzf /tmp/rae-0.1.0-alpha.1.tar.gz | less
shasum -a 256 /tmp/rae-0.1.0-alpha.1.tar.gz
```

Check that the export contains no private paths, credentials, local tool state,
working documents, caches, or runtime output.

## 5. Tag and publish

Only the release owner performs this step:

```bash
git tag -a v0.1.0-alpha.1 -m "RAE v0.1.0-alpha.1"
git push origin main
git push origin v0.1.0-alpha.1
gh release create v0.1.0-alpha.1 \
  --prerelease \
  --notes-file RELEASE_NOTES.md \
  --title "RAE v0.1.0-alpha.1"
```

Attach the reviewed source archive and checksum if they are part of the chosen
release artifact.

## 6. Record closure

- Replace candidate wording in `CHANGELOG.md` and `RELEASE_NOTES.md` with the
  release date.
- Update `RELEASE_STATUS.md` with the tag, commit, hosted workflow results, and
  any residual alpha limitations.
- Verify the GitHub release, badges, security reporting route, and documentation
  links from a logged-out browser.

Do not tag or publish when any required gate is skipped, stale, or
environment-blocked.
