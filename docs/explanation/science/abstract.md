---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Abstract

Reliable agentic engineering should be treated as a systems, measurement, and
publication problem rather than as prompt iteration in isolation.

## Thesis

RAE takes five linked positions:

- planning, production, and verification should be separated when the cost of
  error is material
- context should be selected for signal density rather than accumulated by
  default
- coordination should be topology-aware rather than treated as free parallelism
- benchmark outputs require provenance, calibration, and validity doctrine
- documentation is part of the reliability surface because it changes operator
  choices and publication claims

## Claim classes in this section

- `engineering_heuristic`
  Information density, staged separation, cognitive tiering, layered failure
  analysis
- `formal`
  Coordination topology and contract-versus-gate distinctions
- `governance_rule`
  Validity doctrine and negative-result publication

## Contributions of the science layer

This section provides:

- formal definitions and notation for the workflow model
- mechanistic explanations for why long context and uncontrolled fan-out can
  degrade engineering quality
- a publication doctrine that separates implementation prose from empirical
  support
- explicit limitations so heuristic design guidance is not misread as settled
  science

## Reading map

- [Problem Statement](problem-statement.md)
- [Information Theory](information-theory.md)
- [Coordination Cost](coordination-cost.md)
- [Drift and Self-Certification](drift-and-self-certification.md)
- [Contracts and Gates](contracts-and-gates.md)
- [Cognitive Tiering](cognitive-tiering.md)
- [Threats to Validity](threats-to-validity.md)
- [Limitations](limitations.md)

## Claim dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-017 documentation reliability](../../reference/claims/dossiers/clm-017-documentation-reliability.md)
- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- this section sharpens engineering reasoning; it does not prove universal
  superiority of one runtime architecture
- several claims remain heuristics until targeted ablations are frozen and
  published
- local repo truth still belongs to code, schemas, benchmark cards, and package
  docs

## Source note

- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Diataxis](../../reference/claims/bibliography.md#src-diataxis)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
