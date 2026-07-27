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
python3 scripts/generate_docs_screenshots.py
python3 scripts/generate_docs_screenshots.py --check
```

## 2. Install declared dependencies

Use a clean virtual environment and the hashed lock:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements-ci.txt
```

On macOS, use `requirements-macos.txt` so the pinned Watchdog source archive is
selected for Python 3.14.

Install orchestration dependencies from the lockfile:

```bash
npm --prefix packages/orchestration ci
```

The supported Node.js ranges are `>=20.19.0 <21`, `>=22.12.0 <23`, or
`>=24.0.0`; `./scripts/rae.sh doctor` enforces this contract.

## 3. Run release gates

```bash
./scripts/rae.sh doctor
./scripts/rae.sh agent doctor
./scripts/verify.sh --release-candidate
git diff --check
git status --short
```

The release gate is green only when:

- the strict MkDocs build runs;
- the Git worktree is clean and every release-essential file is tracked;
- all Python, orchestration, Ralph, profile, and hygiene suites pass;
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
