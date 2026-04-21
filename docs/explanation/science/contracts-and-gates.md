---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: ../../reference/contracts/quality-gates.md
evidence_links: ../../reference/claims/evidence-index.md
---

# Contracts and Gates

Contracts and gates are distinct control surfaces and should stay distinct.

## Claim

This page supports the formal claim that structural validity and progression
decisions should remain distinct.

## 1. Contract

A contract says what an artifact must contain and how it should be interpreted.

Typical contract dimensions:

- syntax or schema
- required fields
- semantic field meanings
- provenance requirements

## 2. Gate

A gate says whether the current artifact is sufficient for progression under a
specific decision rule.

Typical gate outputs:

- `pass`
- `warn`
- `fail`

## 3. Why the distinction is mathematically useful

You can think of the contract as a predicate over structure and the gate as a
decision function over both structure and adequacy:

$$
\operatorname{contract\_valid}(A) \in \{\text{true}, \text{false}\}
$$

$$
\operatorname{gate}(A) \in \{\text{pass}, \text{warn}, \text{fail}\}
$$

So an artifact can be:

- contract-valid but strategically weak
- contract-valid but not release-worthy
- locally useful but not benchmark-publishable

That separation is essential for serious documentation and evaluation.

## Repo implication

RAE uses contracts to define artifact shape and interpretation, then uses gates
to block progression or publication when evidence is still weak.

## Claim dossier

- [CLM-015 contract-gate distinction](../../reference/claims/dossiers/clm-015-contract-gate-distinction.md)

## Interpretation limits

- trivial local workflows may collapse these two ideas into one operator choice
- the gate outcomes and thresholds remain implementation-specific policy

## Source note

- [IEEE 1012](../../reference/claims/bibliography.md#src-ieee-1012)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Diataxis](../../reference/claims/bibliography.md#src-diataxis)
