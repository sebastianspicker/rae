---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../reference/claims/evidence-index.md
---

# Source Quality Policy

## Strong sources

- code
- schemas
- reproducible local commands
- primary papers and official documentation
- standards and formal method guidance from recognized bodies

## Weak sources

- ad hoc chat summaries
- memory of older runs without preserved artifacts
- public leaderboard numbers without supporting context
- blogspam or listicles added only to satisfy a source quota
- tangential citations that do not actually support the surrounding statement

## Policy

The broader the claim, the stronger the source must be. A repo-local heuristic
may rely on code and operator evidence. A general scientific claim requires
stronger external grounding.

## Option B interpretation rule

The locked implementation contract requires at least seven real external sources
for every page under `docs/`. That quota does not change what counts as the
source of truth for implementation details:

- command truth still belongs to code, schemas, and package-local docs
- external sources should explain method, limits, human factors, verification,
  or prior art rather than displacing stronger local anchors

## Selection rules

- prefer primary sources over summaries
- prefer durable standards and official documentation for operational doctrine
- prefer peer-reviewed or widely used methodological references for
  implementation and verification claims
- reject decorative citations even if they are real

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Smaldino bad science](../reference/claims/bibliography.md#src-smaldino-bad-science)
