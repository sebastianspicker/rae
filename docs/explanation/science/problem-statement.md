---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Problem Statement

The central problem is not only that agent systems fail. It is that their
failures are often hard to attribute, easy to overclaim, and expensive to audit
after the fact.

## Failure pattern

1. An operator asks for a long or ambiguous task.
2. The system mixes planning, implementation, and verification into one loop.
3. The producing agent implicitly certifies its own work.
4. Success is reported without enough provenance, calibration, or negative
    cases.
5. Documentation compresses uncertainty into confident reference-like prose.

## Formal statement

RAE treats reliability as the conjunction of four properties:

$$
R = R_{\text{execution}} \cap R_{\text{evidence}} \cap R_{\text{interpretation}} \cap R_{\text{documentation}}
$$

A system can appear locally successful while still failing the broader
reliability objective if any one of those surfaces is weak.

## Consequence

This produces systems that may look capable in one run yet remain difficult to
compare, reproduce, or trust over time.

## Repo response

This repository reduces that risk by enforcing separation between:

- artifacts and gates
- execution and evaluation
- reference docs and explanation docs
- provisional heuristics and adopted policy

## Success conditions

The repo aims for:

- explicit stage boundaries
- frozen benchmark and judge metadata
- documentation that names proof mode and limits
- claim publication that resolves to evidence and dossiers

## Claim dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-017 documentation reliability](../../reference/claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- this page frames the problem; it does not by itself measure effect sizes
- low-risk tasks may justify lighter process than the full RAE stack

## Source note

- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
