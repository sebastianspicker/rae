---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: README.md
evidence_links: claims/evidence-index.md
---

# Repo Map

## Top-level surfaces

- `AGENTS.md`
  Umbrella shared memory for cross-runtime workflow rules and repeated
  corrections.
- `docs/`
  Scientific, operational, research, and governance documentation.
- `packages/orchestration/`
  Imported phased orchestration runtime, contracts, adapters, and docs.
- `packages/loops/ralph/`
  Imported deterministic audit/lint/fix loop runtime and tests.
- `tools/repo-hygiene/coauthor-trailer-cleaner/`
  Imported and generalized history-rewrite utility.
- `evals/`
  Benchmark cards, run cards, schemas, scenario families, and results.
- `profiles/agent-environments/`
  Public profile publication lane and sanitization boundary.
- `examples/`
  Small end-to-end examples and starter layouts.
- `scripts/`
  Umbrella harness, verification, and metadata validation.

## Reading rule

Use package-local docs for command truth and umbrella docs for:

- integration logic
- shared workflow memory
- benchmark method
- claim quality
- publication constraints
- stable umbrella entrypoints

## Thesis validation

The repo map is an implementation-reference page. Its local truth comes from the
tree itself, while the broader rationale for separating these surfaces comes
from documentation, verification, and socio-technical systems literature.

## Interpretation limits

- directory layout explains responsibility, not empirical effectiveness by itself

## Source note

- [Diataxis](claims/bibliography.md#src-diataxis)
- [Conway 1968](claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](claims/bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](claims/bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](claims/bibliography.md#src-herbsleb-mockus)
- [NIST GenAI Profile](claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](claims/bibliography.md#src-ieee-1012)
