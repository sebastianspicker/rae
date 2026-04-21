
(P2)

**What the repo has:**

- A heuristic drift detector that uses:
- section heading presence checks,
- keyword overlap,
- deterministic threshold mapping.
- A dual-extractor mode where two independent claim sets are correlated via
  token similarity and adjudicated.

**What was missing in the original baseline:**

- Drift detection is only as good as claim extraction quality. Right now, claim
  extraction is implied (external agents produce claims), but the repo doesn’t have:
- a standardized claim taxonomy,
- an evaluation dataset,
- measures of false positives / false negatives.

**Implemented repository changes (Feb 2026):**

- Standardized drift claim types:
  - e.g., interface, invariant, security, performance, doc
- Added a versioned goldset:
  - `docs/eval/drift_goldset/` with known design/plan pairs and expected drift
    findings
- Added dual-mode benchmark and thresholds:
  - `scripts/eval/drift-benchmark.mjs` computes precision/recall/F1 per class and mode (`heuristic`, `dual-extractor`)
  - default thresholds: `precision >= 0.75`, `recall >= 0.65`, `f1 >= 0.70`

This aligns with the general trend in long-context benchmarking (LongBench) and
MAS evaluation (MAESTRO): the repo needs systematic tests, not anecdotes.

---

## 4) Prioritized roadmap (historical baseline and closure)

P0 — Evaluation and observability baseline

- Completed: execution trace schema + trace event stream (`trace.jsonl`)
- Completed: evaluation harness producing `evaluation-report.json`
- Completed: metrics aggregation across matrix runs

P1 — “Make the theory enforceable”

- Completed: context manifests + per-phase budget gates
- Completed: orchestration policy (runtime fanout decisions)
- Completed: end-to-end traceability (requirements -> tasks -> tests -> drift)

P2 — “Improve measurement and robustness”

- Completed: drift taxonomy + goldset + precision/recall/F1 benchmark
- Review dedup: configurable similarity threshold + better tokenization
  (optional)
- Completed: regression coverage for gate criteria and schema evolution in runtime package tests

---

## 5) How to integrate MAESTRO-style ideas without losing runner-agnosticism

MAESTRO’s key ideas (standardize config/execution; export traces + system
signals) do not require the repo to adopt a specific agent framework.

A compatible approach for the repo:

- Define “adapter contracts” as data formats, not runtime dependencies:
- artifact JSON schemas,
- gate result schemas,
- trace event schemas,
- evaluation report schemas.
- Then provide lightweight example adapters in `adapters/` (optional):
- Runner adapters are now centralized under `adapters/<runner>/skills/*`.
- The repo can add more without changing core principles.

---

## 6) Why these next steps preserve the repo’s identity

The repo’s core stance is: reliability comes from institutional structure:

- phase separation,
- scoped context,
- separation of duties,
- mechanized gates.

Everything proposed here extends that same stance:

- traces make gates measurable at system level,
- evaluation harness makes claims repeatable,
- policies make parallelism economically rational,
- traceability makes intent preservation auditable.

That is exactly the difference between:

“we have a good process” and “we have a falsifiable, instrumented system.”

---

## References

- Liu et al. Lost in the Middle: How Language Models Use Long Contexts
  (arXiv:2307.03172).
- Bai et al. LongBench: A Bilingual, Multitask Benchmark for Long Context
  Understanding (arXiv:2308.14508).
- MAESTRO: Multi-Agent Evaluation Suite for Testing, Reliability, and
  Observability of LLM-based MAS (arXiv:2601.00481).
- Bhatt et al. When Should We Orchestrate Multiple Agents? (arXiv:2503.13577).
