---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-017
---

# CLM-017 Documentation Reliability

## Claim statement

Documentation quality affects operator behavior and therefore belongs inside the
reliability model rather than outside it.

## Claim class

`engineering_heuristic`

## Proof mode

Operational argument supported by documentation architecture, reproducibility,
and governance literature.

## Assumptions

- operators act on documentation, not just on code
- stale or overclaimed docs change runtime choices and publication claims
- documentation structure can either separate or blur kinds of authority

## Internal anchors

- `docs/governance/documentation-policy.md`
- `scripts/verify_repo.py`
- `docs/INDEX.md`
- `packages/orchestration/scripts/pipeline/autonomous.mjs`
- `packages/orchestration/scripts/pipeline/tests/autonomous-checkpoint-scenarios.test.mjs`

## External anchors

- [Diataxis](../bibliography.md#src-diataxis)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)
- [IEEE 1012](../bibliography.md#src-ieee-1012)

## Benchmark artifacts

Documentation review is enforced via `scripts/verify_repo.py`, autonomous
post-build instructions, emitted `documentation-report.json`, and release
review checklists. The end-to-end autonomous fixture verifies that a target doc
change is surfaced in the run report, but no frozen benchmark isolates the
effect of documentation quality yet.

## Counterarguments

- strong operators may ignore weak documentation and inspect the code directly
- some docs failures are less harmful than runtime defects

## Validity threats

- the effect size of documentation quality is task and audience dependent
- improvements in prose do not guarantee improvements in truth

## Review status

Adopted as a repo-level reliability doctrine.

## Source note

- [Diataxis](../bibliography.md#src-diataxis)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../bibliography.md#src-nosek-open-research)
- [IEEE 1012](../bibliography.md#src-ieee-1012)
