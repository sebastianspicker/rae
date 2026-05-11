---
status: stable
owner: core
last_reviewed: 2026-04-28
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

## Maintainer data flow

Most repository flows follow the same path:

1. An operator enters through `./scripts/rae.sh`.
2. The umbrella harness dispatches to orchestration, Ralph, evals, or a narrow
   hygiene tool.
3. The selected runtime writes local artifacts such as `.pipeline/` state,
   benchmark run cards, command-result transcripts, checkpoints, or ledgers.
4. Validators in `scripts/verify_repo.py`, `evals/scripts/`, and package-local
   verification scripts decide whether those artifacts are usable evidence.
5. Claim-bearing docs link to the evidence layer instead of asserting behavior
   directly.

Generated or mirrored surfaces should be edited at their declared source of
truth. In particular, orchestration adapter files under
`packages/orchestration/adapters/<runner>/` are generated from templates, while
package-local runtime behavior stays under the package that owns it.

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
