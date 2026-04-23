---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-016
---

# CLM-016 Cognitive Tiering

## Claim statement

Reasoning budget, autonomy, and review intensity should be tiered by ambiguity,
consequence of error, and checkability rather than maximized uniformly.

## Claim class

`engineering_heuristic`

## Proof mode

Human-factors and automation argument with operational design implications.

## Assumptions

- higher-effort reasoning is scarce and costly
- mechanized checks change how much cognition a task actually needs
- the cost of an error varies materially across task classes

## Internal anchors

- `docs/explanation/science/cognitive-tiering.md`
- `docs/explanation/supplementary/design-axioms.md`

## External anchors

- [Kahneman](../bibliography.md#src-kahneman-fast-slow)
- [Bainbridge automation](../bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../bibliography.md#src-endsley-situation-awareness)
- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)

## Benchmark artifacts

Pending runtime-selection and cost/quality ablations.

## Counterarguments

- a uniform workflow can be easier to teach and operate
- dynamic routing can misclassify tasks and add its own failure modes

## Validity threats

- the thresholds between tiers are policy decisions, not natural constants
- more cognition can still fail when the artifact contract is weak

## Review status

Adopted as a bounded engineering heuristic.

## Source note

- [Kahneman](../bibliography.md#src-kahneman-fast-slow)
- [Bainbridge automation](../bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../bibliography.md#src-endsley-situation-awareness)
- [Amdahl 1967](../bibliography.md#src-amdahl-1967)
- [Anthropic effective agents](../bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
