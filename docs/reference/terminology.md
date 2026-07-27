---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: claims/claims-ledger.md
---

# Terminology

- `artifact`
  Structured output emitted by a stage, loop, or evaluation run.
- `gate`
  A decision record stating whether progression is acceptable.
- `claim`
  A statement that must be either evidenced, explicitly limited, or marked as
  provisional.
- `assumption`
  A condition accepted for now but expected to be re-checked when scope,
  implementation, or benchmarks change.
- `benchmark`
  A versioned task family with defined splits, scoring, and result reporting.
- `benchmark card`
  Metadata record for a benchmark family and its publication constraints.
- `run card`
  Metadata record for one benchmark execution.
- `judge`
  The scoring mechanism, human or model-assisted, used to evaluate outputs.
- `contamination`
  Leakage from benchmark tasks or solutions into model training or evaluation input
  conditions that inflates scores.
- `deterministic loop`
  A runner whose state transitions and story selection rules are explicit and
  reproducible.
- `orchestration`
  A staged workflow that separates intake, design, build, and verification into
  bounded phases.

## Thesis validation

Shared terminology is part of the repo's control surface: stable vocabulary
reduces ambiguity between runtime behavior, benchmark interpretation, and
governance claims.

## Related dossiers

- [CLM-015 contract-gate distinction](claims/dossiers/clm-015-contract-gate-distinction.md)
- [CLM-017 documentation reliability](claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- terminology improves auditability, but strong definitions do not replace
  evidence

## Source note

- [Diataxis](claims/bibliography.md#src-diataxis)
- [Shannon 1948](claims/bibliography.md#src-shannon-1948)
- [Model Cards](claims/bibliography.md#src-model-cards)
- [Datasheets](claims/bibliography.md#src-datasheets)
- [NIST GenAI Profile](claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](claims/bibliography.md#src-ieee-1012)
- [OpenAI evals guidance](claims/bibliography.md#src-openai-evals)
