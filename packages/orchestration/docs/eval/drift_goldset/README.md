# Drift Goldset

This directory contains curated drift-evaluation fixtures.

## Structure

Each case is a JSON file with:

- `id`: case identifier
- `source`: source-of-truth markdown
- `target`: target markdown or implementation notes
- `expected`: expected drift findings in normalized taxonomy classes
- `extractor_claim_sets`: dual-extractor claim inputs (`2` extractors, each with normalized claims)

## Taxonomy

- `interface`
- `invariant`
- `security`
- `performance`
- `docs`

## Usage

These fixtures are consumed by evaluation scripts under `scripts/eval/` to compute precision, recall, and F1 per class and overall.
