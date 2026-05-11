
**What the repo has:**

- The scientific doc already suggests metrics: pass/fail rates, drift trends,
  dedup ratio, time-to-closure.

**What was missing in the original baseline:**

- A repeatable, comparable evaluation harness across runs and configurations:
- baseline (single-agent, no phased gates),
- phased pipeline (current, with explicit parallelism boundary),
- phased + context budget enforcement,
- phased + different drift modes.

This is crucial given research warning that orchestration can be mis-costed and
only helps under certain differentials.

**Implemented repository changes (Feb 2026):**

- Added the evaluation report artifact contract:
  - `contracts/artifacts/evaluation-report.schema.json`
- Added a taskset contract plus strict schema validation:
  - `contracts/eval-taskset.schema.json`
  - `scripts/eval/lib/taskset-validate.mjs`
- Added matrix execution + aggregation flow:
  - `scripts/eval/run-matrix.sh`
  - `scripts/eval/run-matrix.mjs`
  - `scripts/eval/aggregate.mjs`
  - `.pipeline/evaluations/<eval_id>/evaluation-report.json`

#### Minimal metrics set (scientifically defensible)

Let:

- $G_k \in \{\text{pass}, \text{fail}, \text{warn}\}$ gate status for phase $k$
- $T_k$ = phase duration
- $D$ = drift score between design and implementation

The repo already defines drift conceptually; formalize in evaluation:

$$
\mathrm{Drift}(D,X)=
\frac{\sum_{c\in\mathcal{C}(D)} w_c \cdot \mathbf{1}[\neg c(X)]}
{\sum_{c\in\mathcal{C}(D)} w_c}
$$

(The scientific foundation uses this style of definition.)

Then track:

- Pipeline success rate:
  $\frac{\#\text{runs with all mandatory gates pass}}{\#\text{runs}}$
- Mean drift and drift tail risk (e.g., 95th percentile)
- Dedup ratio:

$$
\rho_{\text{dedup}} = \frac{|F_{\text{raw}}|}{|F_{\text{dedup}}|}
$$

(multi-model-review explicitly deduplicates findings.)

- Security time-to-closure: derived from quality-report fix-loop rounds and
  critical/high counts.

Why this matters (long-context + MAS research):

- Long-context evaluation is now standard (LongBench).
- MAS evaluation is shifting toward trace + signals, not just “final
  correctness”.

---

### Gap C — Explicit context budgets + “context manifest” (P1)

**What the repo has:**

- The repo states the principle and gives the information-theoretic motivation: add
  noise -> increase $H(C)$ without increasing $I(I;C)$.
- The pipeline config already encodes cognitive tiers per phase.

**What was missing in the original baseline:**

- A measurable representation of “what context was used” per phase.
- A gateable budget (token or approximate size).

This matters because “Lost in the Middle” shows long-context usage degrades
depending on relevance position. The operational fix is not just “use less
context,” but enforce curated context selection and ordering.

**Implemented repository changes (Feb 2026):**

- Added optional `context_manifest` to artifact schemas:
  - `files_loaded`: list of file paths + byte sizes
  - `docs_loaded`: list of URLs + `retrieved_at`
  - `selection_policy`: free text + parameters
  - `token_estimate` or `char_count_estimate`
- Added quality-gate criterion types:
  - `count-max` for list lengths (`files_loaded <= K`)
  - `number-max` for `token_estimate <= budget`
- Added runtime budget enforcement in `scripts/pipeline/runner.mjs` with shadow/enforce behavior via `context_budget_v1`.

(The repo currently supports `field-exists`, `field-empty`, `count-min`,
`regex-match`.)

Math justification (already in the foundation): the repo defines attention weights:

$$
a_i = \frac{\exp(q\cdot k_i)}{\sum_{j=1}^{L}\exp(q\cdot k_j)}
$$

and argue adding irrelevant tokens increases the denominator, reducing mass
allocated to true signal tokens.

A practical engineering corollary: “budget + selection policy” is not
optional—it is the mechanism that turns the theory into control.

---

### Gap D — Orchestration boundary: keep parallelism explicit (P1)

**What the repo has:**

- Strong “coordination tax” modeling and the “star topology reduces edges from
  O(n²) to O(n)” rationale.
- A cognitive tiering plan in pipeline config.

**What was missing in the original baseline:**

- An explicit boundary for when reviewer or builder parallelism is allowed.
- A guard against adding workers during runtime from inferred quality or cost
  estimates.

**Implemented repository changes (Feb 2026):**

- Added an explicit parallelism boundary in docs:
  - `docs/ORCHESTRATION_POLICY.md`

### Gap E — End-to-end traceability across artifacts (P1)

**What the repo has:**

- The brief schema gives requirements IDs.
- The plan schema exists and can list tests/verification.
- Gates produce structured pass/fail outputs.

**What was missing in the original baseline:**

- A required linkage like:
- tasks reference `requirement_ids`
- tests reference `requirement_ids`
- drift claims reference `requirement_ids` or `constraint_ids`

Without this, the repo can’t compute:

- “coverage of MUST requirements by tests”
- “coverage of constraints by drift checks”
- “which requirement caused a gate failure”

**Implemented repository changes (Feb 2026):**

- Updated schemas with traceability fields:
  - `trace_id` on every requirement/constraint
  - `covers: ["REQ-1", "REQ-7"]` on tasks and tests
- Added traceability gate enforcement:
  - plan phase: MUST coverage by plan tasks + plan tests
  - build phase: MUST coverage by plan tasks + plan tests + drift claims
  - design linkage: warning-only (non-blocking)
  - implementation: `contracts/artifacts/traceability-check.schema.json`, `scripts/pipeline/lib/traceability.mjs`, `scripts/pipeline/runner.mjs`

This directly strengthens the repo’s “judgment-centric” claim: it makes intent
preservation auditable, not just stated.

---

### Gap F — Drift detection quality: from heuristics to measurable precision/recall
