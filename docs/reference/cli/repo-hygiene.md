---
status: experimental
owner: tools
last_reviewed: 2026-04-12
source_of_truth: ../../../tools/repo-hygiene/coauthor-trailer-cleaner/README.md
evidence_links: ../claims/evidence-index.md
---

# Repo Hygiene CLI

## Imported surface

- `tools/repo-hygiene/coauthor-trailer-cleaner/coauthor-trailer-cleaner.sh`
- umbrella wrapper: `./scripts/rae.sh hygiene coauthor-cleaner ...`

## Purpose

Focused history-rewrite utility for removing configured `Co-authored-by` trailer
identities from one or more GitHub repositories.

## Current command contract

- default target: `Cursor <cursoragent@cursor.com>`
- generic override: repeat `--target "Name <email>"`
- config-based override: top-level `targets` array in JSON config
- repo inputs: positional URL/path pairs, `--repos-file`, or `--config`
- safety modes: `--dry-run`, `--validate-only`, `--no-push`

## Verification entrypoint

```bash
(cd tools/repo-hygiene/coauthor-trailer-cleaner && bash ./tests/run-tests.sh)
```

Umbrella smoke path:

```bash
./scripts/rae.sh hygiene coauthor-cleaner --help
```

## Thesis validation

This page documents a narrow destructive utility while validating the design
principle that maintenance-only tools should stay explicit and separate from the
core runtime architecture.

## Related dossiers

- [CLM-005 narrow utilities outside core runtime](../claims/evidence-index.md#clm-005)

## Interpretation limits

- focused tooling lowers category confusion, but destructive operations still
  require strong local safeguards and review

## Source note

- [Conway 1968](../claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
- [Bainbridge automation](../claims/bibliography.md#src-bainbridge-automation)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
- [Diataxis](../claims/bibliography.md#src-diataxis)
