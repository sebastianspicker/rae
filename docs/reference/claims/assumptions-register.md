---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: claims-ledger.md
---

# Assumptions Register

| ID | Assumption | Scope | Review Trigger | Current Risk |
| --- | --- | --- | --- | --- |
| ASM-001 | Docs-first unification is lower-risk than immediate cross-module runtime rewriting. | repository architecture | first integrated release candidate | medium |
| ASM-002 | Public profile material can be sanitized from private source repos without undermining operator usefulness. | profile publication | first public profile import | medium |
| ASM-003 | Benchmark metadata can remain model-agnostic even if scenario execution uses different runners. | evals | first populated benchmark family | medium |
| ASM-004 | Package-local docs can continue to act as command truth while umbrella docs act as scientific and governance truth. | documentation architecture | first major CLI surface change | low |
| ASM-005 | Current imported modules are representative enough to anchor a public reference architecture, even before additional task families are added. | external validity | first public benchmark report | high |

## Use rule

An assumption is not a hidden fact. It is a tracked dependency that should be
revisited when the corresponding trigger fires.

## Thesis validation

The register supports publication discipline by separating accepted scope
dependencies from claims that are already evidenced strongly enough to be
adopted without caveat.

## Interpretation limits

- assumptions reduce hidden uncertainty but do not resolve it
- some assumptions will remain provisional until broader benchmark coverage
  exists

## Source note

- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [OpenAI evals guidance](bibliography.md#src-openai-evals)
- [PaperBench](bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](bibliography.md#src-nosek-open-research)
