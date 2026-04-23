
### 4.1 Canonical Phases and Typed Artifacts

This repo defines canonical phase aliases:

`arm -> design -> adversarial-review -> plan -> pmatch -> build -> quality-static -> quality-tests -> post-build -> release-readiness`

Each phase produces a typed artifact (JSON) and a gate result.

Examples:

- `brief.json` (requirements crystallization)
- `design.json` (evidence-backed architecture)
- `review.json` (deduped adversarial findings + fact checks)
- `plan.json` (atomic task groups + verification)
- `drift-reports/pmatch.json` (adjudicated drift claims)
- `quality-reports/*.json` (static/tests/docs/security/denoise audits)
- `release-readiness.json` (final go/no-go evidence)

### 4.2 Runtime Skills

This repository includes three key runtime packages:

1. **quality-gate**

   - validates artifacts against a JSON schema + acceptance criteria
   - criteria types include: `field-exists`, `field-empty`, `count-min`, `count-max`, `number-max`, `coverage-min`, `regex-match`
   - outputs a structured gate result with blocking failures

2. **multi-model-review**
   - merges findings from multiple reviewers
   - deduplicates via token overlap (Jaccard similarity)
   - produces cost/benefit analysis scaffolding
   - performs drift detection, including **dual-extractor adjudication**

3. **trace-collector**
   - validates run-level execution events against `execution-trace.schema.json`
   - reports deterministic aggregate metrics (event counts, gate results, phase durations, retry/failure counters)
   - emits run summaries used by evaluation workflows

These runtime tools make validation deterministic and machine-checkable.

### 4.3 Why the Old “Orchestration Playground” Degraded

The old pattern (many parallel prompts, patterns, collaboration styles) is effective for exploration, but it fails as:

- context windows grow,
- artifacts accumulate,
- more concurrent contributors join.

Scientifically:

- it increases $H(C)$ (context entropy) faster than it increases $I(I;C)$,
- it increases coordination cost roughly with $\Theta(n^2)$ in unstructured discussion,
- it increases correlated error due to shared context soup,
- it blurs maker/checker roles, enabling self-certification.

Phased orchestration is a structural answer:

- narrow context per phase,
- typed artifact handoffs,
- explicit maker/checker gates,
- controlled parallelism.

---

## 5. Further Integrations

Based on the “judgment-centric” research direction, the repo can be extended further in scientifically meaningful ways without betraying its core principle (minimal noise, maximal verification):

1. **Progressive Disclosure & Explicit Context Budgets**

   - Define a token budget per phase and enforce it (e.g., “design phase max 12k tokens”)
   - Add “context manifest” metadata: exactly what files/docs were loaded and why

2. **Evidence Provenance Strengthening**

   - Expand `research[]` entries to include:
     - `source_url`, `version`, `retrieved_at`, and optionally a hash
   - This turns evidence into an auditable trace

3. **Security Hardening Hooks (Runner-Level)**

   - Pre-tool-use hooks for command filtering
   - Post-download malware scanning hooks
   - These are _guardrails_, not walls, but they reduce risk

4. **Quantitative Metrics for Orchestration Quality**

   - Track:
     - gate pass/fail rates per phase,
     - drift score trends across runs,
     - review dedup ratio (raw findings → deduped findings),
     - time-to-closure for security findings

5. **Formal “Coordination Topology” Documentation**
   - Add a short spec: when to use hub-and-spoke vs bounded group chat
   - Include the explicit scaling law rationale (why $O(n)$ beats $O(n^2)$ )

---

## Glossary

- **Signal-to-noise ratio (context)**: how much intent-relevant information exists relative to total context entropy.
- **Coordination tax**: superlinear overhead as agent count grows, often modeled as $O(n^2)$.
- **Drift**: divergence between source-of-truth artifacts (design/plan) and downstream artifacts (plan/implementation).
- **Gate**: a validation step (schema + criteria) that blocks progression on failure.
- **Design-by-contract**: engineering approach where software components have explicit, enforceable pre/postconditions.

---

## References

(External references are included for scientific framing; the repo itself remains runner-agnostic.)

- Lost in the Middle: How Language Models Use Long Contexts (Liu et al.)  
  <https://arxiv.org/abs/2307.03172>

- On the Computational Complexity of Self-Attention (Duman-Keles et al.)  
  <https://arxiv.org/abs/2209.04881>

- Applying "Design by Contract" (Bertrand Meyer, IEEE Computer 1992)  
  <https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf>

- The Mythical Man-Month / Brooks’s Law (communication channels $n(n-1)/2$)  
  <https://en.wikipedia.org/wiki/The_Mythical_Man-Month>

- Towards a Science of Scaling Agent Systems (Kim et al., 2026)  
  <https://arxiv.org/abs/2512.08296>

- Multi-Agent Collaboration via Evolving Orchestration (Dang et al., 2025)  
  <https://arxiv.org/abs/2505.19591>


---

<!-- markdownlint-disable MD013 -->

# Mathematics & Computer-Science Foundations of **Phased Agent Orchestration**

A rigorous mathematical and informatics explanation of the failure modes that motivated this repository (context dilution, coordination overhead, and drift), and why the repo’s phased, contract-driven, quality-gated approach is a principled mitigation.

---

## 0. Abstract

As LLM context windows grow and multi-agent workflows become common, two coupled problems dominate real-world reliability:

1. **Information dilution:** adding more context often increases _entropy_ more than it increases _useful information_, reducing “information per token” and amplifying spurious correlations.
2. **Coordination tax:** adding more agents increases communication overhead and error propagation, with costs that can scale superlinearly in team size and topology.
3. **Artifact drift:** when planning, coding, and auditing blur, systems “self-certify” and downstream artifacts diverge from upstream intent.

**Phased Agent Orchestration** is an architecture that mitigates these issues by:

- enforcing **phase-scoped context** (information bottleneck),
- using **typed artifacts** (contracts via JSON Schema),
- requiring **hard gates** (Design-by-Contract style),
- applying **independent review / adjudication** (ensemble reliability),
- running **mechanized drift detection** (claim extraction + verification).

---

## 1. Context Dilution as an Information-Theoretic Phenomenon

### 1.1 Intent-to-Output as a Noisy Channel

Model a task as latent _intent_ $I$ (requirements, constraints, goals) that must be preserved through an agent’s _context_ $C$ into an _output_ $Y$ (design/plan/code).

A minimal information-theoretic lens:

- **Entropy**:

$$
H(X) = -\sum_{x} p(x)\log p(x)
$$

- **Mutual information**:

$$
I(I;C) = H(I) - H(I \mid C)
$$

$$
I(C;Y) = H(Y) - H(Y \mid C)
$$

A central quantity for prompt engineering is not “how much context we have,” but how much intent-relevant information per token the context contains.

Define a coarse “information density” metric:

$$
\eta(C) \;=\; \frac{I(I;C)}{|C|}
$$

Where $|C|$ is context length in tokens (or bits). If we append irrelevant material $N$ to the context, $C'=(C,N)$, then typically:

$$
I(I;C') = I(I;C,N) = I(I;C) + I(I;N\mid C)
$$

If the extra text $N$ is largely independent of intent given $C$, then $I(I;N\mid C)\approx 0$. But $|C'| > |C|$. Therefore:

$$
\eta(C') \approx \frac{I(I;C)}{|C|+|N|} < \frac{I(I;C)}{|C|} = \eta(C)
$$

**Conclusion:** under the independence assumption above, appending largely irrelevant material lowers information density even if it raises the total token budget.

This repo’s design choice (“scoped context per phase”) can be interpreted as favoring higher $\eta(C)$ under this toy model: each phase sees only the artifact subset required for its function.

---

### 1.2 Attention Dilution (Mechanistic Interpretation)

For a Transformer, attention weights for a query $q$ and key $k_i$ are:

$$
a_i = \frac{\exp(q^\top k_i)}{\sum_{j=1}^{L}\exp(q^\top k_j)}
$$

When you add $K$ extra tokens, the denominator increases. Even if the model _can_ learn to suppress noise, real systems empirically show sensitivity to where relevant information appears in long contexts (“position effects”).

A widely cited empirical result is that performance often peaks when relevant information is near the beginning or end of the context and degrades when it is in the middle of long contexts (“lost in the middle”). See [Liu2024] for controlled evidence.

---

### 1.3 Empirical Long-Context Limits

Benchmarks and analyses for long-context understanding show that:

- retrieval-like tasks and “needle-in-a-haystack” variants are insufficient alone,
- task complexity and multi-hop reasoning degrade as length grows,
- advertised context sizes do not guarantee robust usage.

Representative sources include:

- “Lost in the Middle” [Liu2024]
- LongBench (multi-task benchmark) [BaiACL2024]
- RULER (synthetic benchmark, configurable complexity) [Hsieh2024]

These results motivate an architectural stance: don’t assume bigger contexts solve the problem; engineer the system so agents receive a curated signal.

---

## 2. Computational Scaling: Why “Just Give It Everything” Gets Expensive

### 2.1 Self-Attention Complexity

Scaled dot-product attention is:

$$
\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
$$

For sequence length $L$, the matrix $QK^\top$ is $L\times L$, so standard attention compute/memory scales approximately as:

$$
\text{Time} \in \Theta(L^2 d), \qquad \text{Memory} \in \Theta(L^2)
$$

This quadratic scaling is a major driver for “efficient transformer” variants and IO-aware implementations.

See:

- Transformer introduction [Vaswani2017]
- survey of efficient approaches [Tay2020]
- IO-aware exact attention (FlashAttention) [Dao2022]

### 2.2 Architectural Consequence

Because attention is expensive and long contexts are behaviorally fragile, an optimal engineering strategy is not “maximize $L$” but to optimize relevance per token and to use external structure (phases, artifacts, gates) to stabilize behavior.

The repository implements this directly: artifact handoffs and gates replace “throw everything into one prompt” as the scaling mechanism.

---

## 3. Coordination Tax: Multi-Agent Systems as Graphs

### 3.1 Communication Channels Scale as a Graph

Model agent collaboration as a graph $G=(V,E)$ where vertices are agents and edges are communication dependencies.

- In a fully connected team of $n$ agents: $|E_{\text{complete}}| = \binom{n}{2} = \frac{n(n-1)}{2}$
  This is the classic “channels of communication” model often discussed in software engineering coordination arguments (popularly associated with Brooks’ observations) [Brooks1975].

- In a hub-and-spoke topology (one orchestrator + $n-1$ workers): $|E_{\text{star}}| = n-1$

So topology changes coordination complexity from $\Theta(n^2)$ to $\Theta(n)$.

### 3.2 A Simple Throughput Model

Let each agent contribute average benefit $b$, and coordination overhead per channel be $\alpha$. One stylized model:

$$
S(n)=nb-\alpha\cdot \frac{n(n-1)}{2}
$$

Maximizing w.r.t $n$ (continuous approximation):

$$
\frac{dS}{dn}=b-\alpha\left(n-\frac12\right)=0
\Rightarrow n^{*} \approx \frac{b}{\alpha}+\frac12
$$

Interpretation:

- if tasks are highly parallel and cheap to coordinate (small $\alpha$), more agents help.
- if tasks are tightly coupled or tool-heavy (large $\alpha$), more agents can reduce performance.

A recent controlled study on agent-system scaling explicitly reports
**topology-dependent effects**, coordination overhead, and cases where
multi-agent variants degrade performance, especially on sequential reasoning
tasks [Kim2025].

---

## 4. Reliability Engineering: Gates as Design-by-Contract

### 4.1 Contracts, Preconditions, Postconditions

Design-by-Contract (DbC) formalizes correctness by explicitly stating:

- **preconditions**: what must be true before execution,
- **postconditions**: what must be true after execution,
- **invariants**: what must remain true.

DbC’s rationale in software engineering is canonical (Meyer) [Meyer1992].

### 4.2 Phases as a Finite-State Machine With Hard Guards

Let phases be states:

$$
\mathcal{S}=\{\texttt{arm},\texttt{design},\texttt{adversarial-review},\texttt{plan},\texttt{pmatch},\ldots\}
$$

Each phase emits an artifact $A_k$. A gate $G_k$ validates it:

$$
A_k = f_k(A_{k-1}, C_k)
$$

$$
G_k(A_k)\in\{\text{pass},\text{fail},\text{warn}\}
$$

Transition rule:

$$
\text{advance from phase }k \iff G_k(A_k)=\text{pass}
$$

This repo implements this _literally_ using JSON schemas and gate artifacts:

- Universal gate schema: `contracts/quality-gate.schema.json`
- Artifact schemas: `contracts/artifacts/*.schema.json`

This provides an operational analogue of DbC assertions: the artifact plays the role of a postcondition, and the gate is the runtime checker.

---

## 5. Probabilistic Error Containment: Why Early Gates Matter
