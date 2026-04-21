# Gap Analysis & Roadmap (Feb 2026)

## Implementation Status (Feb 22, 2026)

- [x] Gap A (P0): execution trace contract, runtime emission, and trace-collector validation/summaries are implemented.
- [x] Gap B (P0): evaluation-report contract, matrix runner, schema-validated tasksets, and metric aggregation are implemented.
- [x] Gap C (P1): context manifests and runtime budget gates (`count-max`, `number-max`) are implemented.
- [x] Gap D (P1): deterministic orchestration policy is documented, configured, and enforced at runtime.
- [x] Gap E (P1): end-to-end traceability linkage and MUST-coverage gates are implemented.
- [x] Gap F (P2): drift taxonomy, goldset, and precision/recall/F1 benchmark thresholds are implemented.

## Phased Agent Orchestration — Research Alignment and Closure Status

> **Goal of this document:** derive concrete improvements / next steps for
> `phased-agent-orchestration` from the repo’s own scientific framing _and_ from
> recent research on (1) long-context failure modes, (2) multi-agent
> orchestration cost/benefit, and (3) evaluation + observability of multi-agent
> systems.

This roadmap is designed to be repo-native:

- keep the workflow phase-scoped (no “accumulated chat soup”),
- keep validations machine-checkable (schemas + gates),
- keep runtime tooling offline / runner-agnostic where possible.

---

## Status Note (Feb 22, 2026)

All Gap A-F workstreams are implemented in repository code and active verification flows.
The analysis sections below are intentionally retained as scientific rationale and historical framing.

- Gap A: `contracts/artifacts/execution-trace.schema.json`, `scripts/pipeline/lib/trace.mjs`, `skills/dev-tools/trace-collector/`
- Gap B: `contracts/artifacts/evaluation-report.schema.json`, `scripts/eval/run-matrix.mjs`, `scripts/eval/aggregate.mjs`, `scripts/eval/lib/taskset-validate.mjs`
- Gap C: `contracts/artifacts/*context_manifest*`, `skills/dev-tools/quality-gate/src/lib/criteria.ts`, `scripts/pipeline/runner.mjs`
- Gap D: `docs/ORCHESTRATION_POLICY.md`, `docs/pipeline/pipeline-state.template.json`, `scripts/pipeline/lib/policy.mjs`
- Gap E: `contracts/artifacts/traceability-check.schema.json`, `scripts/pipeline/lib/traceability.mjs`, `scripts/pipeline/runner.mjs`
- Gap F: `docs/eval/drift_goldset/`, `scripts/eval/drift-benchmark.mjs`

---

## 0) TL;DR — What’s already strong, and what was initially missing

### What the repo already does well (and why this is scientifically aligned)

- **Phase separation + typed artifacts + hard gates**: deterministic control
  around non-deterministic generators (LLMs).
  (`contracts/artifacts/*.schema.json`, `contracts/quality-gate.schema.json`,
  `skills/dev-tools/quality-gate`)
- **Context minimization / scoped transfer**: explicitly prevents long-context
  “attention dilution” and “lost in the middle” effects.
- **Bounded multi-agent parallelism** (lead + workers, isolated reviewers) +
  dedup: reduces “too many cooks” coordination overload and correlated errors.
- **Mechanized drift detection** (including dual-extractor adjudication option):
  formalizes “design → plan → implementation” alignment and blocks
  self-certification.

### What was most missing in the initial analysis (now implemented)

1. **Standardized execution traces + system signals** (latency, cost, failures,
   tool-use, phase transitions) to enable reliable evaluation and debugging at
   scale. This is a central theme in recent MAS evaluation work (e.g., MAESTRO).
2. **An evaluation harness** that can answer: _Does this orchestration help vs.
   single-agent baselines under realistic constraints?_ (cost, latency,
   availability). This directly connects to recent findings that orchestration
   can be overestimated and only helps under certain differentials.
3. **Explicit context budgets + “context manifests”** per phase (what was
   loaded, why, and how big). This is the operational bridge between the theory
   (“context is noise”) and measurable engineering reality.
4. **End-to-end traceability**: requirement → design constraint → plan task →
   test case → implementation evidence → gate result. The repo has the right
   building blocks; the missing piece is a _first-class linking mechanism_
   across artifacts.

---

## 1) Current repo architecture (as the baseline for “what to improve”)

### 1.1 The “phased pipeline” is already encoded as an institutional control structure

The repo encodes the workflow as a canonical sequence (arm → design →
adversarial-review → plan → pmatch → build → quality-\* → release-readiness)
with explicit “advance only if gate passes” semantics.

### 1.2 Contracts + gates make outputs machine-checkable

- Artifact schemas define structural contracts (e.g., brief, design doc,
  review report, plan, drift report, quality report, release readiness).
- `quality-gate` validates schema + acceptance criteria and produces structured
  gate results with statuses and evidence.

### 1.3 Multi-model review and drift detection are already partially “formalized”

- Dedup uses token-overlap Jaccard similarity to reduce redundant findings
  (signal-to-noise improvement).
- Drift detection supports (a) heuristic matching and (b) dual-extractor
  adjudication where two independent claim sets are correlated and conflicts are
  resolved via a deterministic policy.

### 1.4 The README’s “why the old playground degraded” matches known failure modes

The repo explicitly states it evolved from a broader orchestration playground
and became noisy as context grew and contributors multiplied (“signal-to-noise
degraded”, “too many cooks”).

---

## 2) Research signals (2023–2026) that should influence next steps

### 2.1 Long-context isn’t “free”; position effects are real

**Lost in the Middle** shows that performance can degrade significantly
depending on where relevant information appears, with models often doing better
when relevant info is near the beginning or end, and worse when it’s in the
middle of long contexts.

**Implication for this repo:**  
The “phase-scoped context” principle is directionally correct, but the next
maturity step is to (a) measure and (b) enforce context budgets and
retrieval/ordering policies per phase.

### 2.2 Benchmarking long-context understanding is now standard practice

**LongBench** explicitly exists because “comprehensive benchmarks tailored for
evaluating long context understanding are lacking,” and it provides a multi-task
benchmark to evaluate long-context behavior.

**Implication for this repo:**  
The repo needs a repeatable evaluation harness that includes long-context stress
tests and measures whether the orchestration reduces failure probability
relative to baseline workflows.

### 2.3 Multi-agent orchestration benefits are conditional, not automatic

**When Should We Orchestrate Multiple Agents?** warns orchestration strategies
can overestimate performance and underestimate costs, and argues orchestration
is effective only if there are performance/cost differentials between agents
under realistic constraints.

**Implication for this repo:**  
The repo should add an explicit policy layer that decides when to go
multi-agent (and how many agents) based on budget + expected marginal value.

### 2.4 Evaluation & observability for MAS is becoming a first-class research area

**MAESTRO** positions itself as an evaluation suite for
testing/reliability/observability of LLM-based multi-agent systems, emphasizing
standardized configuration/execution and exporting framework-agnostic traces and
system-level signals (latency/cost/failures).

**Implication for this repo:**  
The design was already close conceptually (phase state + gates), but it lacked
a first-class trace layer to make behavior empirically inspectable and comparable.

---

## 3) Gap analysis (repo vs. historical baseline)

### Gap A — Observability and trace standardization (P0)

**What the repo has:**

- `pipeline-state.template.json` tracks phases and completed gates.
- `quality-gate` reports execution time and logs for that tool execution.

**What was missing in the original baseline:**

- A **run-level execution trace** that spans the entire pipeline and includes:
  - phase transitions,
  - which artifacts were read/written,
  - which agents/models participated (even as abstract tiers),
  - system signals: latency, costs, failures, retries,
  - tool-use metadata,
  - gate outcomes + blockers.

This aligns directly with MAESTRO’s emphasis on framework-agnostic traces and
system-level signals.

**Implemented repository changes (Feb 2026):**

1. Added the execution trace contract:
   - `contracts/artifacts/execution-trace.schema.json`
2. Added run-level trace artifacts:
   - `.pipeline/runs/<run_id>/trace.jsonl` (append-only event stream)
   - `.pipeline/runs/<run_id>/trace.summary.json` (collector summary)
3. Added and integrated the runtime trace validator/summarizer:
   - `skills/dev-tools/trace-collector/`
   - `scripts/pipeline/lib/trace.mjs`
   - `scripts/pipeline/runner.mjs`

#### Recommended minimal trace event model (JSONL)

```json
{
  "ts": "2026-02-22T12:00:00Z",
  "event": "phase_start",
  "phase": "design",
  "run_id": "..."
}
{
  "ts": "...",
  "event": "artifact_read",
  "phase": "design",
  "path": ".pipeline/runs/.../brief.json",
  "bytes": 12345
}
{
  "ts": "...",
  "event": "agent_call",
  "phase": "design",
  "tier": "high_reasoning",
  "model_hint": "(optional)",
  "tokens_in": 1234,
  "tokens_out": 567
}
{
  "ts": "...",
  "event": "gate_result",
  "phase": "design",
  "status": "pass",
  "gate_id": "design-gate",
  "blocking_failures": []
}
```

This preserves the runner-agnostic philosophy: tier is required; `model_hint`,
`tokens_*`, `cost_*` are optional but strongly recommended.

### Gap B — Quantitative evaluation harness (P0)
