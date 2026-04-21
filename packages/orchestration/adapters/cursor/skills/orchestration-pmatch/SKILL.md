---
name: orchestration-pmatch
description: "Cursor adapter for /pmatch. Runs dual independent claim extraction and adjudicates drift before allowing progression."
---

# /pmatch - Dual-Extractor Drift Adjudication (Cursor Adapter)

## Use this when
- Plan-vs-design or implementation-vs-plan conformance must be verified.
- The user requests `/pmatch`, drift detection, or claim verification.

## Model tier
- Extractors: fast worker models in isolated contexts.
- Lead: balanced-reasoning adjudicator for structured conflict resolution and mitigation decisions.

## Semantic intent
- Separation of duties: extractors work independently; lead adjudicates.
- Evidence-first guidance: every drift finding must map to explicit claims and evidence.

## Inputs
- Source artifact: `.pipeline/runs/<run-id>/{design.json|plan.json}`
- Target artifact: `.pipeline/runs/<run-id>/{plan.json|implementation refs}`

## Procedure

### 1. Launch dual independent extractors
Start two Task subagents with no shared intermediate context. Each returns:
- extracted claims (`id`, `claim`, `verification_status`, `evidence`, optional `confidence`)
- extractor identifier.

### 2. Build extractor claim sets
Assemble:
- `drift_config.mode = "dual-extractor"`
- `drift_config.extractor_claim_sets` with exactly two extractor claim sets.

### 3. Run runtime adjudication
Call `multi-model-review` with:
- `action.type = "drift-detect"`
- `document` set to source artifact content/type
- `drift_config.target_ref` set to target artifact path
- `drift_config.mode = "dual-extractor"`
- `drift_config.extractor_claim_sets` from Step 2.

### 4. Lead mitigation pass
For high/critical drift findings:
- attach mitigation action or explicit justification,
- resolve conflicts called out in `adjudication`.

### 5. Build artifact
Write drift report to:
- `.pipeline/runs/<run-id>/drift-reports/pmatch.json`

### 6. Gate evaluation
Validate:
- schema compliance (`contracts/artifacts/drift-report.schema.json`)
- no unmitigated critical/high drift findings
- adjudication metadata present (`mode`, `extractors`, `conflicts_resolved`, `resolution_policy`)
- each claim includes extractor attribution.

Write gate output:
- `.pipeline/runs/<run-id>/gates/pmatch-gate.json`

## Non-negotiables
- No extractor cross-talk
- No high/critical drift accepted without mitigation or explicit human sign-off
- Dual-extractor mode is the default; heuristic mode is fallback-only
