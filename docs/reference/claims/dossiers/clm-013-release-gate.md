---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-013
---

# CLM-013 Release Gate

## Claim statement

Claim-bearing benchmark publication requires an explicit release gate that
blocks on regressions, evidence gaps, or unresolved checkpoints.

## Claim class

`governance_rule`

## Proof mode

Normative governance rule operationalised by the release gate script and the
release-criteria policy; grounded in verification and validation doctrine.

## Assumptions

- a release gate is an automated check that must pass before results can be
  treated as published
- regressions, evidence gaps, and unresolved checkpoints are each independently
  sufficient to block publication
- the gate is the final automated control surface before human review

## Internal anchors

- `evals/scripts/release_gate.py`
- `docs/governance/release-criteria.md`
- `docs/reference/contracts/human-checkpoints.md`
- `docs/reference/contracts/result-ledger.md`

## External anchors

- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [PaperBench](../bibliography.md#src-openai-paperbench)

## Benchmark artifacts

The release gate is run by `verify.sh`; gate pass/fail status is recorded in
run-cards for each frozen benchmark.

## Counterarguments

- automated gates can produce false negatives if blocking conditions are
  incompletely specified
- gate strictness must be balanced against iteration velocity in early
  development

## Validity threats

- the gate blocks on known failure modes; novel failure modes that are not yet
  encoded will not be caught
- human checkpoint review downstream of the gate is still required for
  publication-strength claims

## Review status

Adopted as a mandatory publication precondition for all claim-bearing benchmarks.

## Source note

- [IEEE 1012](../bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [PaperBench](../bibliography.md#src-openai-paperbench)
