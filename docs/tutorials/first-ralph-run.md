---
status: stable
owner: loops
last_reviewed: 2026-07-16
source_of_truth: packages/loops/ralph
evidence_links: ../reference/claims/evidence-index.md
---

# First Ralph Run

This tutorial walks through the minimum local Ralph `0.3.0` path. Ralph is
Codex-only: its `audit` and `linting` modes are read-only, while `fixing` uses a
story-scoped filesystem transaction with recovery.

## Assumptions

- you are at the repository root
- GNU Bash 5.3+, Python 3.14.6+, `jq`, and the Codex CLI are available
- you only want to validate the loop surface first

## 1. Validate the PRD

```bash
./scripts/rae.sh ralph --validate-prd
```

## 2. Inspect current state

```bash
./scripts/rae.sh ralph --status
./scripts/rae.sh ralph --list-stories
```

## 3. Run a small audit batch

```bash
MODE=audit ./scripts/rae.sh ralph 1
```

Codex execution uses a positive deadline, a 15-second graceful shutdown, and
bounded output (16 MiB raw output and 2 MiB final report). Try `MODE=fixing`
only after reviewing the selected story and transaction boundary.

## 4. Run package verification

```bash
./scripts/rae.sh ralph tests
```

## 5. Bootstrap the embedded template into another repo

```bash
mkdir -p /tmp/rae-demo-repo
./scripts/rae.sh workflow repo-audit bootstrap /tmp/rae-demo-repo
```

## What this demonstrates

- deterministic story selection
- explicit mode control
- state-aware loop execution
- regression-backed safety behavior

## Thesis validation

This tutorial demonstrates the bounded deterministic-loop thesis on a minimal
operator path.

## Related dossiers

- [CLM-010 reproducibility layers](../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- tutorial success does not substitute for frozen benchmark evidence

## Source note

- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
