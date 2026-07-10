<!-- markdownlint-disable MD013 -->

# Scientific Foundations of Phased Agent Orchestration

> **Contract-driven, quality-gated multi-agent delivery pipeline from idea to validated implementation.**  
> This document provides a scientific and mathematical rationale for _why phased orchestration_ is a principled response to the failure modes of large-context and multi-agent AI software workflows.

---

## Table of Contents

- [Abstract](#abstract)
- [1. The Core Problem](#1-the-core-problem)
  - [1.1 Context Dilution as an Information-Theoretic Failure Mode](#11-context-dilution-as-an-information-theoretic-failure-mode)
  - [1.2 Long Context is Not Free](#12-long-context-is-not-free)
  - [1.3 The Coordination Tax](#13-the-coordination-tax)
  - [1.4 Drift and Self-Certification](#14-drift-and-self-certification)
- [2. Principles](#2-principles)
  - [2.1 Judgment-Centric Engineering](#21-judgment-centric-engineering)
  - [2.2 Contracts and Gates](#22-contracts-and-gates)
  - [2.3 Phase-Scoped Context](#23-phase-scoped-context)
  - [2.4 Cognitive Tiering](#24-cognitive-tiering)
  - [2.5 Independent Adversarial Review](#25-independent-adversarial-review)
  - [2.6 Mechanized Drift Detection](#26-mechanized-drift-detection)
- [3. A Formal Model of the Pipeline](#3-a-formal-model-of-the-pipeline)
  - [3.1 Pipeline as a Finite-State Machine](#31-pipeline-as-a-finite-state-machine)
  - [3.2 Reliability Gains from Gates](#32-reliability-gains-from-gates)
  - [3.3 Optimal Team Size Under Coordination Cost](#33-optimal-team-size-under-coordination-cost)
- [4. How This Repository Implements These Principles](#4-how-this-repository-implements-these-principles)

---

## Abstract

LLM-based software workflows fail in predictable ways when they scale:

1. **Large contexts** cause **signal-to-noise collapse**: adding more tokens does _not_ guarantee adding more usable information.
2. **Many concurrent agents** cause **coordination overhead** and error amplification: more contributors can reduce throughput and quality (“too many cooks”).
3. **Planning → coding → auditing** often blurs into a single loop, enabling **self-certification** and **drift** (implementation diverges from intent/design).

**Phased Agent Orchestration** addresses these failure modes by applying:

- **phase separation** (one job per phase),
- **typed artifacts** (machine-checkable outputs),
- **hard quality gates** (no phase advances without validation),
- **scoped context** (no “accumulated chat soup”),
- **independent critique** (adversarial review and drift detection).

The result is an architecture derived from information constraints, not ceremony.

---

## 1. The Core Problem

### 1.1 Context Dilution as an Information-Theoretic Failure Mode

Let:

- $I$ be the (latent) **human intent** (requirements, constraints, goals).
- $C$ be the **context** provided to an agent (prompt + repo info + docs + intermediate artifacts).
- $Y$ be the produced output (plan/design/code).

We want high alignment between intent and output. One lens is the **mutual information** between intent and what the agent _effectively_ uses:

$$
I(I;C) \quad \text{(how much information about intent is contained in context)}
$$

Now split context into **signal** and **noise**:

- $S$: intent-relevant information (constraints, spec, ground truth)
- $N$: irrelevant or weakly relevant information (stale prompts, parallel patterns, old discussions)

So:

$$
C = (S, N)
$$

If $N$ is approximately independent of intent given $S$ (typical for “extra fluff”), then:

$$
I(I;C) = I(I;S,N) = I(I;S) + I(I;N \mid S) \approx I(I;S)
$$

Meaning: adding noise increases tokens but not intent information.

A useful normalized measure is:

$$
\mathrm{SNR}_{\text{info}}(I \rightarrow C) \;=\; \frac{I(I;C)}{H(C)}
$$

Since $H(C)$ (entropy / description length) increases with noise, while $I(I;C)$ barely increases, the normalized signal-to-noise ratio drops:

$$
\mathrm{SNR}_{\text{info}} \downarrow \quad \text{as noise tokens grow}
$$

**Interpretation:** Larger context windows can create worse reasoning because they can dilute relevant information with irrelevant material.

#### Attention Dilution (Mechanistic Intuition)

Transformer attention assigns weights:

$$
a_i = \frac{\exp(q \cdot k_i)}{\sum_{j=1}^{L}\exp(q \cdot k_j)}
$$

Adding $K$ additional irrelevant tokens increases the denominator. Under mild assumptions (irrelevant keys are not always trivially separable), the expected total mass allocated to true signal tokens decreases roughly with:

$$
\mathbb{E}\left[\sum_{i \in S} a_i\right] \approx \frac{|S|}{|S|+K}
$$

So even if the model _could_ pay attention to everything, real attention is **competitive**. More tokens means more competition.

---

### 1.2 Long Context is Not Free

Even ignoring reasoning degradation, long context has computational implications.

For standard self-attention, compute/memory scales ~quadratically with sequence length $L$:

$$
\text{Cost} \in \Theta(L^2)
$$

So increasing context length by factor $r$ can increase attention cost by ~ $r^2$.

**Implication:** Practical systems must optimize not just “what’s true” but “what’s worth loading.”

---

### 1.3 The Coordination Tax

Multi-agent systems introduce an overhead: every additional agent increases the **communication surface** and **state synchronization burden**.

A classic model (Brooks-style) is the number of pairwise communication channels in a fully connected team:

$$
E_{\text{complete}}(n) = \frac{n(n-1)}{2}
$$

If coordination cost per channel is $\alpha$, then:

$$
C_{\text{coord}}(n) \approx \alpha \cdot \frac{n(n-1)}{2} \in \Theta(n^2)
$$

That is the “too many cooks” problem in math form.

#### Star Topology Reduces Overhead

If you shift from group chat to a **hub-and-spoke** structure (one orchestrator + workers), edges become:

$$
E_{\text{star}}(n) = n-1 \in \Theta(n)
$$

So the architecture (communication topology) changes the scaling law.

**Phased orchestration** tends to enforce star-like coordination:

- the lead orchestrator assigns tasks,
- workers do scoped work,
- results are merged through gates and reviews — not free-form group chat.

---

### 1.4 Drift and Self-Certification

Let:

- $D$ be the **design artifact** (source of truth for architecture/constraints),
- $P$ be the **plan** (execution blueprint),
- $X$ be the **implementation** (code).

A common failure is:

$$
D \not\Rightarrow P \quad \text{and/or} \quad P \not\Rightarrow X
$$

Because humans and agents are fallible, and because each transformation is lossy.

Drift can be formalized as a divergence between required constraints and realized constraints. If we define a set of constraints $\mathcal{C}(D)$ extracted from design, then a drift score can be:

$$
\mathrm{Drift}(D, X) \;=\; \frac{\sum_{c \in \mathcal{C}(D)} w_c \cdot \mathbf{1}[\neg c(X)]}{\sum_{c \in \mathcal{C}(D)} w_c}
$$

Where:

- $c(X)$ is a predicate “implementation satisfies constraint $c$”
- $w_c$ weights severity/importance.

**Self-certification** is the anti-pattern where the same agent that created $X$ also declares $X$ correct without independent validation, causing correlated blind spots.

---

## 2. Principles

### 2.1 Judgment-Centric Engineering

A useful philosophical inversion:

- **Code** is a liability surface (bugs, security risk, maintenance).
- **Judgment** (clear intent, correct constraints, verified decisions) is the scarce asset.

Phased orchestration is designed to preserve judgment:

- capture intent explicitly before implementation,
- force evidence-backed design,
- require independent pressure-testing,
- mechanize drift checks and quality audits.

---

### 2.2 Contracts and Gates

Each phase emits an artifact $A_k$. A gate $G_k$ decides whether it is valid.

$$
A_k = f_k(A_{k-1}, \text{scoped context})
$$

$$
G_k(A_k) \in \{\text{pass}, \text{fail}\}
$$

Pipeline progression:

$$
\text{advance} \iff G_k(A_k) = \text{pass}
$$

This is a **design-by-contract** view:

- JSON schema validation ≈ structural contract
- acceptance criteria ≈ semantic contract
- “no advance on fail” ≈ enforced postcondition

---

### 2.3 Phase-Scoped Context

A core claim of the repo is:

> “Context is scoped per phase; no phase inherits prior conversation history.”

This implements **context min-maxing**:

- maximize relevance $S$,
- minimize noise $N$,
- avoid accumulating irrelevant prior discussion.

In information terms: aim to maximize $I(I;C)$ subject to a budget on $H(C)$.

---

### 2.4 Cognitive Tiering

Not all models/agents should do the same job. A rational allocation is:

- **High-reasoning lead**: strategy, synthesis, arbitration
- **Fast workers**: implementation, audits, mechanized checks

This matches the idea of minimizing **expensive reasoning cycles** while maximizing **checkable throughput**.

---

### 2.5 Independent Adversarial Review

Instead of “one agent tries to be correct,” you want independent perspectives.

If a failure is detected with probability $r$ by one reviewer, then with $m$ independent reviewers:

$$
P(\text{caught}) = 1 - (1-r)^m
$$

Even with moderate $r$, parallel review improves recall.

But independence matters: if reviewers share the same context soup, their errors correlate.

So the repo’s emphasis on isolated reviewer contexts is mathematically coherent: it increases the likelihood that blind spots differ.

---

### 2.6 Mechanized Drift Detection

Drift match is implemented as a claim-verification problem:

1. Extract claims $\mathcal{C}$ from source artifact (design/plan).
2. Verify each claim against target artifact (plan/implementation).
3. Produce a structured drift report.

#### Dual-Extractor Coverage Gain

If each extractor covers a true claim with probability $r$, using two independent extractors yields:

$$
P(\text{covered}) = 1 - (1-r)^2 = 2r - r^2
$$

Example: $r=0.7 \Rightarrow P(\text{covered}) = 0.91$

This motivates evaluating **dual-extractor adjudication** as the default pmatch
mode, but it is a modeling argument rather than a standalone empirical proof.

#### Dedup and Similarity via Jaccard

To reduce repeated findings across reviewers, the repo uses token-overlap similarity:

$$
J(A,B) = \frac{|A \cap B|}{|A \cup B|}
$$

If $J(A,B) \ge \tau$, findings are treated as duplicates (merged), increasing signal-to-noise in review artifacts.

---

## 3. A Formal Model of the Pipeline

### 3.1 Pipeline as a Finite-State Machine

Let phases be states:

$$
\mathcal{S} = \{\text{arm}, \text{design}, \text{adversarial-review}, \text{plan}, \text{pmatch}, \text{build}, \text{quality-static}, \text{quality-tests}, \text{post-build}, \text{release-readiness}\}
$$

Transitions are conditional on gates:

$$
s_{k+1} = T(s_k, A_k) \quad \text{only if} \quad G_k(A_k)=\text{pass}
$$

This is a deterministic control structure around non-deterministic generators (LLMs).

---

### 3.2 Reliability Gains from Gates

Suppose phase $k$ has probability $p_k$ of introducing a defect into its artifact without a gate.

Let the gate detect such a defect with probability $d_k$ (detection power).

Then residual defect probability for that phase becomes:

$$
p_k^{\text{res}} = p_k(1-d_k)
$$

If defects are approximately independent across phases (a simplifying assumption), the probability that the final output contains at least one defect is:

$$
P_{\text{defect}} = 1 - \prod_{k=1}^{K} (1 - p_k^{\text{res}})
$$

Adding gates increases $d_k$, reducing $p_k^{\text{res}}$, and reducing total defect risk.

Key: gating is a reliability multiplier.

---

### 3.3 Optimal Team Size Under Coordination Cost

Let each agent add benefit $b$, and coordination cost be quadratic:

$$
S(n) = nb - \alpha \cdot \frac{n(n-1)}{2}
$$

Maximize $S(n)$. Approximate in continuous $n$:

$$
\frac{dS}{dn} = b - \alpha\left(n-\frac{1}{2}\right)
$$

Setting to zero:

$$
n^{*} \approx \frac{b}{\alpha} + \frac{1}{2}
$$

So if coordination costs rise, optimal team size shrinks.

The repo reduces $\alpha$ by:

- scoping tasks (file ownership),
- star-like orchestration (lead + workers),
- artifact handoffs instead of open discussion.

---

## 4. How This Repository Implements These Principles
