---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: editorial
evidence_links: ../reference/claims/claims-ledger.md
---

# Documentation Policy

Documentation is part of the product surface and part of the reliability model.

## Structural rules

- keep tutorial, how-to, reference, and explanation docs separate
- use `research/` for benchmark doctrine and results
- use `governance/` for policy, release, and review rules
- keep command truth in package-local docs when the package owns the CLI

## Frontmatter status

The `status` field records the review maturity of the page. It does not promise
API, schema, configuration, or behavioral stability. Capability maturity must
be stated in prose as implemented, experimental, limited, deprecated, or
planned. During the alpha series, a page may be `stable` as documentation while
the interface it describes remains subject to change.

## Article classes and proof modes

- `formal`
  Support with definitions, assumptions, derivations, propositions, and linked
  contracts or algorithms where applicable.
- `empirical`
  Support with benchmark protocol, run artifacts, judge metadata, uncertainty,
  and validity discussion.
- `engineering_heuristic`
  Support with mechanistic argument, strong internal anchors, external
  literature, and explicit scope limits.
- `governance_rule`
  Support with normative rationale, release or auditability needs, and the
  policy surfaces that enforce the rule.
- `implementation_reference`
  Support with code, schema, command surface, or package-local documentation.
  Under the locked Option B contract these pages still need seven external
  sources, but those sources belong in source notes or companion pages rather
  than replacing repo-local truth.

## Scholarly writing rules

- inline math uses `$...$`; display math uses `$$...$$`
- equations are unnumbered by default; number them only when later prose refers
  to the same equation more than once on a core formal page
- symbols should be defined in
  [Notation](../explanation/supplementary/notation.md) or at first local use
- science pages should use a stable structure: claim or problem statement,
  definitions, assumptions, model or derivation, interpretation limits, and
  evidence or implementation anchors
- formal models, heuristics, empirical findings, and governance rules must be
  labeled in prose so the reader can tell what kind of authority a statement has

## Article contract

- every page in `docs/` is subject to the locked minimum of seven real external
  sources
- every claim-bearing page must also preserve the strongest available internal
  anchors for repo-local truth
- narrow operational or policy pages may satisfy most of the external-source
  burden through a linked companion proof page or source note, but they may not
  drop the quota from the published article set
- claim-bearing pages should include a scope or thesis statement, assumptions,
  limitations, and links to the relevant claim dossier or evidence surface

## Claim rules

- claim-bearing pages must link to evidence
- major cross-page theses should resolve to a claim dossier under
  `docs/reference/claims/dossiers/`
- provisional claims must be labeled as provisional
- explanation pages may motivate a design but may not impersonate benchmark
  results
- formula-bearing pages must distinguish explanatory formalism from validated
  empirical measurement

## Citation rules

- use `CITATION.cff` when citing the repository as a software artifact
- use [Bibliography](../reference/claims/bibliography.md) as the canonical
  source of external cite keys for documentation pages
- do not invent page-local source labels when a bibliography cite key already
  exists

## Proof-reading rubric

Every documentation review should check:

- grammar, concision, and category fit
- claim strength versus evidence strength
- notation consistency with
  [Notation](../explanation/supplementary/notation.md)
- link integrity and dossier traceability
- source relevance and source quality
- drift against code, schemas, contracts, and package-local docs
- at least one explicit limitation or uncertainty block

## Freshness rules

- every docs page needs frontmatter
- every release must review claim-bearing pages for drift
- stale pages should be corrected, downgraded, or removed rather than silently
  left in place

## Source note

- [Diataxis](../reference/claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../reference/claims/bibliography.md#src-nosek-open-research)
