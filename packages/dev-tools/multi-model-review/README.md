# Multi-Model Review

This package processes pre-collected review findings. It deduplicates findings,
adjusts severity when reviewers agree, calculates cost and benefit, and detects
drift between a source document and a target document.

## No external APIs

The package does not call external APIs or run reviewers. Its caller supplies
the findings or extractor results to process.

## Actions

### review

Accepts a non-empty `reviewer_findings` array and:

1. deduplicates similar findings with Jaccard token similarity;
2. promotes severity when findings overlap;
3. evaluates cost and benefit; and
4. returns a structured review report.

### drift-detect

Compares a source document with the file named by
`drift_config.target_ref`. The action either uses heuristic claim extraction or
adjudicates exactly two supplied extractor claim sets in
`dual-extractor` mode. It returns claims, drift findings, and adjudication
metadata.

The action fails when the target cannot be read.

## Input

```json
{
  "action": { "type": "review" },
  "document": { "content": "...", "type": "design" },
  "reviewer_findings": [
    {
      "reviewer_id": "architect-reviewer",
      "role": "architect",
      "findings": [
        { "id": "a1", "category": "feasibility", "description": "...", "severity": "high" }
      ]
    }
  ]
}
```

## Output

Standard run-result envelope (`success`, `data`, `metadata`, `logs`).

- `review` data conforms to `packages/contracts/v1/schemas/artifacts/review-report.schema.json`.
- `drift-detect` data conforms to `packages/contracts/v1/schemas/artifacts/drift-report.schema.json`.

## Usage

```bash
echo '{ ... }' | node dist/index.js
```

## Development

Run from the repository root after `npm ci`:

```bash
npm --prefix packages/dev-tools/multi-model-review run lint
npm --prefix packages/dev-tools/multi-model-review run format:check
npm --prefix packages/dev-tools/multi-model-review run build
```

This package has no standalone test script; its contract is exercised by the
engine and repository verification suites.

## Locked container build and protocol checks

Build with the repository root as the context:

```bash
docker build -f packages/dev-tools/multi-model-review/sandbox/Dockerfile -t rae-multi-model-review .
docker run --rm rae-multi-model-review --healthcheck
```

The image compiles the shared package and this tool with the root workspace
lockfile, includes the versioned schemas, and runs as the existing non-root
`skill` user.
