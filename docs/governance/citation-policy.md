---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../reference/claims/bibliography.md
---

# Citation Policy

## Canonical citation surfaces

- `CITATION.cff` is the machine-readable citation record for the repository as a
  whole.
- `docs/reference/claims/bibliography.md` is the canonical registry for
  page-level external cite keys.
- The documentation stack currently stays Markdown-backed for bibliography
  authority. This repo does not maintain a separate BibTeX source of truth.
- Claim dossiers under `docs/reference/claims/dossiers/` are the canonical home
  for extended proof packets, counterarguments, and source bundles for major
  repo theses.

## Claim classes and required anchors

- implementation claims
  Cite the owning code, schema, contract, or package-local documentation that is
  the source of truth.
- implementation/reference statements under Option B
  Preserve the local source of truth and add a source note or companion packet
  with at least seven relevant external sources that justify the broader method,
  documentation, verification, or human-factors framing.
- empirical claims
  Cite the benchmark card, run card, result ledger, judge version, and any
  external method source needed to interpret the result.
- external literature claims
  Cite the primary publication or official documentation via a stable
  bibliography anchor.
- policy or editorial claims
  Cite the governing repo document and any imported external standard when the
  rule is not purely local.

## What must be cited

- scientific claims
- benchmark interpretation rules
- result summaries
- external methodological guidance
- article-level source notes needed to satisfy the locked seven-source quota

## Preferred source order

1. code and schemas for implementation claims
2. frozen benchmark artifacts for empirical claims
3. official documentation and primary publications for external guidance
4. editorial summaries only when the stronger sources are unavailable

## Article quota rule

- every article in `docs/` must cite at least seven real external sources
- those sources should be chosen to match the page function: foundational theory
  for science pages, methods literature for research pages, and standards or
  durable process literature for operational and governance pages
- when the main article would become unreadable, move most of the external
  source packet into a companion page but keep the source links visible from the
  main article

## Workflow

1. add or update the external source entry in
   [Bibliography](../reference/claims/bibliography.md)
2. cite the stable `#src-*` anchor from the claim-bearing page
3. link the claim-bearing page to the relevant internal or external evidence
   anchor
4. link major cross-page theses to the relevant dossier page
5. state uncertainty directly when the cited source does not fully support the
   surrounding interpretation

## Interpretation rules

- do not present heuristics as settled science
- cite the benchmark card and run card when discussing a result
- cite the judge and rubric version when judgment affects the result meaning
- when evidence is incomplete, state the limit directly

## Source note

- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
