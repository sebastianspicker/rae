---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Model of Failure

The repo uses a layered failure model rather than a single "the model was
wrong" explanation.

## Layer 1: representation failure

Intent or constraints are missing, ambiguous, or weakly encoded in artifacts.

Examples:

- intake leaves open questions unresolved
- plan does not preserve design constraints
- docs omit benchmark split or judge version

## Layer 2: inference failure

The model or operator fails to use the available information well.

Examples:

- relevant context is drowned by noise
- long-context retrieval degrades on mid-position information
- a judge mis-scores because the rubric is underspecified

## Layer 3: coordination failure

Multiple contributors interfere or duplicate effort.

Examples:

- all-to-all review threads create contradictory action items
- builders change overlapping files
- orchestration fan-out exceeds useful merge capacity

## Layer 4: governance failure

The result is described or published more strongly than justified.

Examples:

- heuristic arguments presented as empirical conclusions
- benchmark numbers reported without contamination discussion
- explanation pages treated as reference truth

A useful engineering response depends on the layer. More model power does not
fix governance failure, and stricter schema validation alone does not fix
coordination failure.

## Claim dossier

- [CLM-020 layered failure model](../../reference/claims/dossiers/clm-020-layered-failure-model.md)

## Interpretation limits

- layers can interact and overlap in one incident
- the taxonomy is for diagnosis and review, not for exact causal attribution

## Source note

- [Lost in the Middle](../../reference/claims/bibliography.md#src-lost-in-the-middle)
- [Cataldo et al.](../../reference/claims/bibliography.md#src-cataldo-congruence)
- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
