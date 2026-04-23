
The repo includes a “meta” rule: the pipeline must be able to verify itself.

### 5.1 One command to verify the entire repo

Run:

```bash
./scripts/verify.sh
```

This performs:

1. skill validation
2. stale reference checks
3. tracked-file hygiene checks
4. markdown link integrity checks
5. adapter sync + orchestration integrity checks
6. lint/format-check/build/test for runtime packages (`quality-gate`, `multi-model-review`, `trace-collector`)

Fast diff-aware mode is available for local/PR loops:

```bash
./scripts/verify.sh --changed-only
```

### 5.2 Orchestration integrity checks (why this matters)

The integrity check script enforces:

- every pipeline stage has an adapter
- every adapter references its expected gate filename
- stage order consistency between pipeline adapter and orchestration playbook
- phase coverage exists in contracts/quality-gate.schema.json
- pmatch adapter must include dual-extractor references

This is an internal consistency theorem: if any of these invariants break, the orchestration is no longer scientifically testable (because you can’t even assert what “correct progression” means).

## 6. Mathematical rationale: why “phased, gated, scoped” beats “big context + many patterns”

### 6.1 Context is noise: an information-theoretic view

Let a context window be a sequence of tokens $X$ composed of:

- relevant signal $S$
- irrelevant content (noise) $N$

So $X = (S, N)$.

A useful proxy for “how learnable/useful the context is” for a given task $Y$ is mutual information:

$$
I(X; Y) = I(S,N;Y) = I(S;Y) + I(N;Y \mid S)
$$

In practice, $I(N;Y \mid S)$ is close to 0 (noise rarely helps) but it still consumes attention and increases the risk of spurious correlations.

A phase-scoped system implicitly optimizes a “mutual information per token” objective:

$$
\max_{\text{context}} \ \frac{I(X;Y)}{|X|}
$$

Phased orchestration improves this ratio by:

- reducing $|X|$ (tight context boundaries)
- maintaining $I(S;Y)$ by ensuring each phase receives only the required artifacts

This is why the repo forbids carrying full conversational history across phases and instead transfers only typed artifacts.

---

### 6.2 Coordination tax: why many agents or patterns can get worse

With $n$ concurrent contributors, naive coordination overhead often scales like the number of pairwise interactions:

$$
C(n) \propto \binom{n}{2} = \frac{n(n-1)}{2}
$$

Even if each agent adds useful work $D_i$, total performance $P(n)$ can degrade:

$$
P(n) = \sum_{i=1}^{n} D_i - C(n)
$$

This repo reduces $C(n)$ structurally via:

- bounded task groups (3–6 tasks, max 8)
- exclusive file ownership (no shared writes)
- separation of duties (builders don’t certify)
- gated progression (failure halts the pipeline early)

---

### 6.3 Dual-extractor drift adjudication: reducing error by independent extraction

Assume two independent extractors produce claim verifications.
Let each extractor have probability $p$ of producing an incorrect verification for a given claim.

If their errors are independent, the probability both are wrong is:

$$
P(\text{both wrong}) = p^2
$$

So with $p = 0.2$, we get:

$$
p^2 = 0.04
$$

Under this toy independence model, the probability of a shared wrong decision
falls from `p` to `p^2`. That is a useful design intuition, not a measured
repo-wide error reduction claim.

This is why:

- extractor cross-talk is forbidden
- adjudication metadata is required
- dual-extractor is the default (heuristic mode is fallback-only)

---

### 6.4 Gates as an “absorbing” progression model

Each phase transition is permitted only on pass.
Model the pipeline as a Markov process over stage states:

- $s_i$: phase $i$
- $f_i$: failure state for phase $i$

With a gate, failures become absorbing states until remediation occurs (external intervention), which prevents silent drift accumulation.

This is the intended safety property:

Failed states do not advance without remediation.

---

## 7. Scientific framing: “judgment-centric agentic engineering”

The repo operationalizes a judgment-centric premise:

- Human judgment is the scarce asset
- Unverified code is a liability
- Therefore, the process must preserve intent and minimize unvalidated output

Mechanisms in this repo that encode that philosophy:

- /arm forces explicit decisions early (no “guessing requirements”)
- /design enforces evidence and repo alignment
- /ar enforces adversarial critique + fact-checking
- /plan forces predeclared verification
- /pmatch detects drift mechanistically (before it becomes expensive)
- quality gates enforce static, tests, docs, security
- release-readiness forces an explicit go/no-go governance artifact

---

## 8. What you can integrate next (research-backed extensions that fit this repo)

These additions strengthen scientific framing without breaking structure:

1. Add measurable pipeline metrics

- Drift rate: violated claims / total claims per pmatch run
- Gate failure rate per phase
- Rework ratio: fixes after vs before pmatch

1. Add “evidence bundles”

- Store sources used in design decisions as structured references (already partially covered by research[].verified_at).

1. Formalize “context budgets”

- Each stage could declare a max token budget and enforce “artifact-only transfer” discipline.

1. Institutionalize “model diversity” without hard dependencies

- Keep API-independence by allowing the runner to provide model outputs, while the runtime tool remains the deterministic adjudicator.

---

## 9. Appendix: minimal artifact examples

### 9.1 Brief (arm) — must close open questions

```json
{
  "requirements": [{ "id": "R1", "description": "...", "priority": "must" }],
  "constraints": [{ "type": "hard", "description": "...", "source": "user" }],
  "non_goals": [{ "description": "...", "reason": "..." }],
  "style": { "tone": "concise" },
  "key_concepts": [{ "term": "drift", "definition": "..." }],
  "decisions": [{ "decision": "...", "rationale": "..." }],
  "open_questions": []
}
```

### 9.2 Drift report (pmatch) — adjudication required

```json
{
  "source_document": { "type": "design", "ref": ".pipeline/.../design.json" },
  "target_document": { "type": "plan", "ref": ".pipeline/.../plan.json" },
  "claims": [
    {
      "id": "C1",
      "claim": "Plan defines verification commands for lint+tests",
      "verification_status": "verified",
      "evidence": "plan.json: verification_commands[...]",
      "extractor": "extractor-A",
      "confidence": 0.86
    }
  ],
  "findings": [
    { "description": "...", "severity": "high", "claim_ids": ["C7"] }
  ],
  "adjudication": {
    "mode": "dual-extractor",
    "extractors": ["extractor-A", "extractor-B"],
    "conflicts_resolved": 1,
    "resolution_policy": "prefer-evidence"
  }
}
```

## 10. TL;DR

This repository is a scientific answer to two failure modes:

1. Context dilution in large windows (signal-to-noise collapse)
2. Coordination tax in multi-agent / multi-pattern collaboration (too many cooks)

It solves them using:

- strict phase separation
- typed artifacts
- mechanized gates
- independent review/audit contexts
- drift detection with dual-extractor adjudication
- verification scripts that keep the orchestration internally consistent
