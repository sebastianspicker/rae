# Multi-Model Review

Finding-processing engine for adversarial review pipelines. Accepts pre-collected findings from multiple reviewer agents, deduplicates across sources, and runs cost/benefit analysis. Also supports drift detection between source-of-truth and target documents.

## No external APIs

This skill does **not** call external model APIs. The actual adversarial review is performed by your agent runner (e.g. by spawning independent reviewer workers such as architect/security/performance). This skill processes the collected results.

## Actions

### review

Accepts `reviewer_findings` — an array of findings from multiple reviewers — and:
1. Deduplicates similar findings across reviewers (Jaccard token similarity)
2. Promotes severity when findings overlap
3. Runs cost/benefit analysis per finding
4. Returns a structured review report

### drift-detect

Compares a source document against a target document:
1. Runs heuristic claim extraction/verification (default), or
2. Adjudicates two independent extractor claim sets (`mode: "dual-extractor"`)
3. Returns claims, drift findings, and adjudication metadata (`mode`, `extractors`, `conflicts_resolved`, `resolution_policy`)

`drift-detect` requires `drift_config.target_ref` and fails if the file cannot be read.
`mode: "dual-extractor"` requires exactly two `extractor_claim_sets`.

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
- `review` data conforms to `contracts/artifacts/review-report.schema.json`.
- `drift-detect` data conforms to `contracts/artifacts/drift-report.schema.json`.

## Usage

```bash
echo '{ ... }' | node dist/index.js
```

## Development

```bash
npm install
npm run lint
npm run format:check
npm run build
npm test
```
