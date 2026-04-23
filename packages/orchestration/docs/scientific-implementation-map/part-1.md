<!-- markdownlint-disable MD013 -->

# Scientific & Engineering Rationale — Implementation Map for _Phased Agent Orchestration_

> **Core thesis**: Reliability in agentic software delivery is achieved less by “smarter prompts” and more by institutional structure: narrow context, explicit handoffs, verifiable artifacts, independent checks, and hard gates.

---

## 1) Why this repo exists (and why the “playground” approach collapses)

The repository intentionally moved away from a “many patterns in parallel” playground into a **phased pipeline** with strict validation and scoped context.

Two forces drive this:

1. **Large context windows do not scale linearly in value**
2. **Many concurrent agents create a coordination tax that grows superlinearly**

The resulting failure mode is predictable:

- More context → more irrelevant tokens → more noise
- More parallel patterns/contributors → more disagreements, duplicates, contradictions
- Planning/coding/auditing blur → agents “self-certify” their own output → drift accumulates until it’s expensive to fix

This repo’s countermeasure is a simple rule:

> No stage can move forward until its output is validated.

---

## 2) System architecture: two layers + contracts + gates

This repository is designed as two separable layers:

### 2.1 Orchestration layer (runner-specific)

- Canonical adapters: `../adapters/<runner>/skills/orchestration-*/SKILL.md`
- Canonical templates: `../adapters/templates/`
- Deterministic generation + sync check: `../scripts/adapters/generate_adapters.py` and `../scripts/check-adapter-sync.sh`
- Canonical adapter guidance: `../adapters/<runner>/skills/orchestration-*/SKILL.md`

These files define _how_ a runner should execute each stage and what artifacts/gates it must produce.

### 2.2 Runtime layer (runner-agnostic)

- Quality gate runtime: `../skills/dev-tools/quality-gate/`
- Review/drift runtime: `../skills/dev-tools/multi-model-review/`
- Trace runtime: `../skills/dev-tools/trace-collector/`
- Artifact & gate schemas: `../contracts/`

These components are intentionally API-independent (no paid model API calls required). They validate, merge, adjudicate, and gate.

### 2.3 Contracts (typed artifacts)

Each phase produces an artifact validated against `../contracts/artifacts/*.schema.json`.

Key contracts include:

- `../contracts/artifacts/brief.schema.json`
- `../contracts/artifacts/design-document.schema.json`
- `../contracts/artifacts/review-report.schema.json`
- `../contracts/artifacts/execution-plan.schema.json`
- `../contracts/artifacts/drift-report.schema.json`
- `../contracts/artifacts/quality-report.schema.json`
- `../contracts/artifacts/release-readiness.schema.json`
- `../contracts/artifacts/execution-trace.schema.json`
- `../contracts/artifacts/evaluation-report.schema.json`

### 2.4 Gate schema (universal)

All gates converge on:

- `../contracts/quality-gate.schema.json`

Gates are emitted as structured pass/fail/warn results and block progression on failure.

---

## 3) Canonical pipeline: phases, artifacts, gates, adapters

The pipeline order is canonical:

```text
arm -> design -> adversarial-review -> plan -> pmatch -> build
-> quality-static -> quality-tests -> post-build -> release-readiness
```

### 3.1 Phase-by-phase mapping (what lives where)

#### Phase: `arm` (Requirements crystallization)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-arm/SKILL.md`
- Artifact schema: `../contracts/artifacts/brief.schema.json`
- Artifact output path: `.pipeline/runs/<run-id>/brief.json`
- Gate output path: `.pipeline/runs/<run-id>/gates/arm-gate.json`

**Gate intent**: enforce decision completeness (e.g., `open_questions` must be empty).

---

#### Phase: `design` (First-principles, evidence-backed design)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-design/SKILL.md`
- Artifact schema: `../contracts/artifacts/design-document.schema.json`
- Artifact output path: `.pipeline/runs/<run-id>/design.json`
- Gate output path: `.pipeline/runs/<run-id>/gates/design-gate.json`

**Scientific intent**: stop “design by model memory”. The contract requires `research[].verified_at` timestamps to force explicit grounding.

---

#### Phase: `adversarial-review` (Parallel specialist critique + fact-check)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-ar/SKILL.md`
- Artifact schema: `../contracts/artifacts/review-report.schema.json`
- Artifact output path: `.pipeline/runs/<run-id>/review.json`
- Gate output path: `.pipeline/runs/<run-id>/gates/adversarial-review-gate.json`

**Key mechanism**: reviewer outputs are consolidated via the runtime skill:

- `../skills/dev-tools/multi-model-review/` (action type `review`)

**Hard constraint**: no critical/high finding may remain `inconclusive` at fact-check closure.

---

#### Phase: `plan` (Deterministic execution blueprint)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-plan/SKILL.md`
- Artifact schema: `../contracts/artifacts/execution-plan.schema.json`
- Artifact output path: `.pipeline/runs/<run-id>/plan.json`
- Gate output path: `.pipeline/runs/<run-id>/gates/plan-gate.json`

**Coordination control**:

- target 3–6 tasks per group (max 8)
- file ownership is _exclusive_ (`file_ownership`: no file appears in more than one group)
- each task has test cases + acceptance criteria

---

#### Phase: `pmatch` (Mechanized drift detection with dual-extractor adjudication)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-pmatch/SKILL.md`
- Artifact schema: `../contracts/artifacts/drift-report.schema.json`
- Artifact output path: `.pipeline/runs/<run-id>/drift-reports/pmatch.json`
- Gate output path: `.pipeline/runs/<run-id>/gates/pmatch-gate.json`

**Default mode**: `dual-extractor` (two independent claim extractors).  
**Adjudication metadata is mandatory** (`mode`, `extractors`, `conflicts_resolved`, `resolution_policy`).

Runtime adjudicator:

- `../skills/dev-tools/multi-model-review/` (action type `drift-detect`)

---

#### Phase: `build` (Coordinated parallel implementation + conformance check)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-build/SKILL.md`
- Artifact output: implementation changes + `.pipeline/.../gates/build-gate.json`

**Non-negotiables**:

- lead coordinates, builders implement
- builders see only their task group scope
- post-build conformance check uses `pmatch` plan vs implementation

---

#### Phase: `quality-static` (Lint/format/type/build as a hard gate)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-quality-static/SKILL.md`
- Artifact schema: `../contracts/artifacts/quality-report.schema.json` (`audit_type = static`)
- Output path: `.pipeline/.../quality-reports/static.json`
- Gate path: `.pipeline/.../gates/quality-static-gate.json`

---

#### Phase: `quality-tests` (Predeclared tests as a dedicated gate)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-quality-tests/SKILL.md`
- Artifact schema: `../contracts/artifacts/quality-report.schema.json` (`audit_type = tests`)
- Output path: `.pipeline/.../quality-reports/tests.json`
- Gate path: `.pipeline/.../gates/quality-tests-gate.json`

---

#### Phase: `post-build` (denoise + audits + security fix-loop)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-postbuild/SKILL.md`
- Artifact schema: `../contracts/artifacts/quality-report.schema.json` (multiple audit types)
- Outputs:
  - `.pipeline/.../quality-reports/denoise.json`
  - `.pipeline/.../quality-reports/frontend.json`
  - `.pipeline/.../quality-reports/backend.json`
  - `.pipeline/.../quality-reports/docs.json`
  - `.pipeline/.../quality-reports/security.json`
- Gate: `.pipeline/.../gates/postbuild-gate.json`

**Security is special**: the quality schema enforces:

- mandatory category coverage
- fix-loop evidence (`before` vs `after`, rescan completed)
- accepted-risk requires `owner` + `expiry`

---

#### Phase: `release-readiness` (final ship gate)

- Runner adapter (example cursor): `../adapters/cursor/skills/orchestration-release-readiness/SKILL.md`
- Artifact schema: `../contracts/artifacts/release-readiness.schema.json`
- Output: `.pipeline/.../release-readiness.json`
- Gate: `.pipeline/.../gates/release-readiness-gate.json`

This phase forces explicit:

- semver impact
- changelog update
- migration requirements (validated for major)
- rollback plan ownership + tested
- approvals

---

## 4) Runtime tools: how gating and adjudication are mechanized

### 4.1 `quality-gate` runtime skill

Location:

- `../skills/dev-tools/quality-gate/`

It validates:

1. **schema compliance** (JSON Schema)
2. **acceptance criteria** (lightweight checks) that block progression

The input schema supports criteria types such as:

- `field-exists`
- `field-empty`
- `count-min`
- `count-max`
- `number-max`
- `coverage-min`
- `regex-match`

This means phases can express gates like:

- `open_questions` must be empty (arm)
- `research[].verified_at` must exist (design)
- “no TODO placeholders” in plan code_patterns (plan)

### 4.2 `multi-model-review` runtime skill

Location:

- `../skills/dev-tools/multi-model-review/`

This is the “adjudication engine” for:

- adversarial review consolidation (`action.type = review`)
- drift detection adjudication (`action.type = drift-detect`)

It produces structured outputs with:

- deduplicated findings
- fact-check statuses
- cost/benefit and recommendations
- drift claims + adjudication metadata

It performs no paid API calls. The runner (Cursor tasks / agent teams) generates the raw findings/claims; this skill merges them into a deterministic artifact.

### 4.3 `trace-collector` runtime skill

Location:

- `../skills/dev-tools/trace-collector/`

It validates execution traces and summarizes run-level system signals:

- validates each event against `../contracts/artifacts/execution-trace.schema.json`
- aggregates event/gate counts and phase durations
- tracks retry/failure counters and token/cost totals
- writes deterministic run summaries used by evaluation aggregation

---

## 5) Verification harness: preventing the orchestration from rotting
