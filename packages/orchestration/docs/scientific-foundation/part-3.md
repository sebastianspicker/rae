
### 5.1 Residual Defect Probability Per Phase

Suppose phase $k$ introduces a defect with probability $p_k$.
Suppose its gate detects defects with probability $d_k$.

Then residual defect probability after gating:

$$
p_k^{\text{res}} = p_k(1-d_k)
$$

If phases are approximately independent, probability of at least one defect surviving across $K$ phases:

$$
P(\text{defect}) = 1-\prod_{k=1}^{K}\left(1-p_k^{\text{res}}\right)
$$

Even modest $d_k$ (detection power) can drastically reduce risk because gating composes multiplicatively across phases.

### 5.2 “Fail Fast” Minimizes Expected Rework Cost

Let the cost to fix a defect discovered after phase $k$ be $c_k$, typically increasing with time (later discovery is more expensive).

Expected rework cost:

$$
\mathbb{E}[C] = \sum_{k=1}^{K} c_k \cdot P(\text{defect discovered at phase }k)
$$

Architectures that move checks earlier reduce $\mathbb{E}[C]$. This is the core economic argument for gates.

---

## 6. Independent Review as an Ensemble: Why Multi-Model Critique Helps (If Structured)

### 6.1 Detection Probability Increases With Independent Reviewers

If each reviewer detects a specific defect with probability $r$ (independent), then probability it is caught by at least one of $m$ reviewers:

$$
P(\text{caught}) = 1-(1-r)^m
$$

### 6.2 Majority Voting and Condorcet’s Jury Theorem

Assume each reviewer (or extractor) makes the correct binary judgment with probability $p$, independently. For odd $n$, the probability majority is correct is:

$$
P_{\text{maj}}(n,p)=\sum_{k=\lceil n/2 \rceil}^{n}\binom{n}{k}p^k(1-p)^{n-k}
$$

Under the standard independence assumption, Condorcet’s jury theorem states that if $p>\tfrac12$, then $P_{\text{maj}}(n,p)\to 1$ as $n\to\infty$ [Berg1993].

**But independence is critical.** If all reviewers share the same noisy context and the same blind spots, their errors correlate and ensemble gains collapse. This repo’s design (isolated phases + structured artifacts + dedup/fact-check) is explicitly aimed at preserving reviewer independence.

### 6.3 Self-Consistency as a Related Principle

“Self-consistency” (sampling diverse reasoning paths and selecting the most consistent) improves reasoning accuracy in LLMs [Wang2022]. Conceptually, it’s the same ensemble logic applied to reasoning trajectories rather than distinct agents.

---

## 7. Drift Detection as a Verification Problem (and Why “Dual-Extractor” Matters)

### 7.1 Drift as Constraint Violation Rate

Let upstream artifact $S$ define a constraint set $\mathcal{C}(S)$.
Let downstream target $T$ (plan or code) be checked against these constraints.

Define weighted drift:

$$
\mathrm{Drift}(S,T)=\frac{\sum_{c\in\mathcal{C}(S)} w_c\cdot \mathbf{1}[\neg c(T)]}{\sum_{c\in\mathcal{C}(S)} w_c}
$$

This reduces “drift” to a measurable metric.

### 7.2 Claim Extraction + Verification as Hypothesis Testing

For each claim $c$, verification is a hypothesis test:

- $H_0$: “claim holds in target”
- $H_1$: “claim violated / not supported”

A practical system must balance:

- false positives (calling drift where none exists),
- false negatives (missing true drift).

### 7.3 Dual-Extractor Adjudication

If each extractor makes an incorrect verification with probability $p$, and errors are independent, probability both are wrong:

$$
P(\text{both wrong}) = p^2
$$

So dual extraction reduces “confidently wrong” decisions quadratically in $p$ _when independence holds_.

This repo encodes dual extraction as a first-class artifact requirement:

- `contracts/artifacts/drift-report.schema.json` requires `adjudication.mode` and supports `dual-extractor`.

### 7.4 Robust Estimation Analogy (RANSAC / PROSAC)

RANSAC is a robust “hypothesize-and-verify” paradigm designed to tolerate high outlier rates [Fischler1981]. PROSAC refines sampling using ordered hypotheses for efficiency [Chum2005].

Mechanized drift detection is conceptually similar:

- hypotheses = extracted claims,
- verification = evidence check,
- outliers = hallucinated/unverifiable claims,
- adjudication = outlier rejection & consensus.

This analogy is useful because it emphasizes **structured verification** over “trusting one generator.”

---

## 8. Mapping the Theory to the Repository (Concrete Mechanisms)

This repository operationalizes the above ideas with explicit contracts.

### 8.1 Typed Artifacts (JSON Schema)

- Requirements crystallization artifact:

  - `contracts/artifacts/brief.schema.json`
  - includes `open_questions` which “must be empty to pass the arm quality gate” (schema description).

- Evidence-backed design artifact:

  - `contracts/artifacts/design-document.schema.json`
  - requires `research[]` with `verified_at` timestamps.

- Atomic execution plan artifact:

  - `contracts/artifacts/execution-plan.schema.json`
  - enforces:
    - `tasks.maxItems = 8` (bounded complexity per group),
    - `file_ownership` invariant: _no file may appear in more than one group_.

- Drift report artifact:

  - `contracts/artifacts/drift-report.schema.json`
  - requires `adjudication` with `mode` and extractor metadata.

- Universal gate result:
  - `contracts/quality-gate.schema.json`
  - enumerates phases and provides consistent pass/fail semantics.

### 8.2 Why These Constraints Directly Reduce Coordination Tax

The `file_ownership` constraint can be modeled as a partition-like restriction on a conflict hypergraph.

Let each task group $g$ own a set of files $F_g$.
The schema enforces:

$$
F_g \cap F_h = \varnothing \quad \text{for } g\neq h
$$

This removes a major class of multi-agent merge conflicts and reduces coordination edges between builders.

### 8.3 Why Phase-Scoped Context Improves Information Density

By forcing each phase to consume only upstream artifacts (brief/design/plan) rather than the entire conversational backlog, the repo approximates an **information bottleneck** principle:

$$
\max \ I(I;Z) \quad \text{s.t. } |Z|\le B
$$

Where $Z$ is the phase context and $B$ is a tight budget. Here the artifact is a compressed sufficient statistic for the next phase.

---

## 9. Suggested Measurements (Making the Claims Falsifiable)

To evaluate whether phased orchestration helps in your environment, track:

1. **Gate failure rate per phase**

$$
\hat{p}_{\text{fail}}(k)=\frac{\text{number of fails in phase }k}{\text{number of runs in phase }k}
$$

2. **Drift score trend**

$$
\mathrm{Drift}(S,T)\ \text{over time}
$$

3. **Review dedup ratio**

$$
\rho=\frac{\text{number of raw findings}}{\text{number of deduplicated findings}}
$$

   High $\rho$ suggests large redundancy and thus high coordination noise.

4. **Rework cost proxy**

- number of changed files after pmatch vs before
- number of reruns of quality gates

These metrics directly operationalize the theory: information density, coordination overhead, and drift containment.

---

## 10. References

### Information theory

- [Shannon1948] C. E. Shannon. _A Mathematical Theory of Communication_. Bell System Technical Journal, 1948.  
  PDF: `https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf`
- [KullbackLeibler1951] S. Kullback and R. A. Leibler. _On Information and Sufficiency_. Annals of Mathematical Statistics, 1951. DOI: `10.1214/aoms/1177729694`  
  Abstract/record: `https://projecteuclid.org/journals/annals-of-mathematical-statistics/volume-22/issue-1/On-Information-and-Sufficiency/10.1214/aoms/1177729694.full`

### Transformers and long-context behavior

- [Vaswani2017] A. Vaswani et al. _Attention Is All You Need_. NeurIPS 2017. arXiv: `1706.03762`  
  `https://arxiv.org/abs/1706.03762`
- [Tay2020] Y. Tay, M. Dehghani, D. Bahri, D. Metzler. _Efficient Transformers: A Survey_. arXiv: `2009.06732`; ACM Computing Surveys (2022). DOI: `10.1145/3530811`  
  `https://arxiv.org/abs/2009.06732`
- [Dao2022] T. Dao et al. _FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness_. NeurIPS 2022. arXiv: `2205.14135`  
  `https://arxiv.org/abs/2205.14135`
- [Liu2024] N. F. Liu et al. _Lost in the Middle: How Language Models Use Long Contexts_. TACL 2024. DOI: `10.1162/tacl_a_00638`; arXiv: `2307.03172`  
  `https://arxiv.org/abs/2307.03172`
- [BaiACL2024] Y. Bai et al. _LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding_. In ACL 2024.  
  `https://aclanthology.org/2024.acl-long.172/`
- [Hsieh2024] C.-P. Hsieh et al. _RULER: What’s the Real Context Size of Your Long-Context Language Models?_ arXiv: `2404.06654`  
  `https://arxiv.org/abs/2404.06654`

### Ensembles and reliability

- [Wang2022] X. Wang et al. _Self-Consistency Improves Chain of Thought Reasoning in Language Models_. arXiv: `2203.11171` (ICLR 2023)  
  `https://arxiv.org/abs/2203.11171`
- [Berg1993] S. Berg. _Condorcet’s Jury Theorem Revisited_. European Journal of Political Economy, 9(3), 1993. DOI: `10.1016/0176-2680(93)90010-R`  
  `https://www.sciencedirect.com/science/article/pii/017626809390010R`

### Coordination and agent-system scaling

- [Brooks1975] F. P. Brooks. _The Mythical Man-Month: Essays on Software Engineering_. Addison-Wesley, 1975 (Anniversary Ed. 1995).  
  (Discussion of coordination overhead; commonly expressed channel count $n(n-1)/2$.)
- [Kim2025] Y. Kim et al. _Towards a Science of Scaling Agent Systems_. arXiv: `2512.08296`  
  `https://arxiv.org/abs/2512.08296`
### Contracts and formalism

- [Meyer1992] B. Meyer. _Applying “Design by Contract”_. IEEE Computer, 1992.  
  `https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf`

### Robust verification analogy

- [Fischler1981] M. A. Fischler, R. C. Bolles. _Random Sample Consensus: A Paradigm for Model Fitting…_ Communications of the ACM, 1981. DOI: `10.1145/358669.358692`
- [Chum2005] O. Chum, J. Matas. _Matching with PROSAC — Progressive Sample Consensus_. CVPR 2005. DOI: `10.1109/CVPR.2005.221`  
  PDF: `https://cmp.felk.cvut.cz/~matas/papers/chum-prosac-cvpr05.pdf`

---

## 11. Key Takeaway

The repo’s phased approach is not arbitrary ceremony. It is a rational response to:

- information dilution in long contexts,
- coordination overhead in multi-agent systems,
- drift and self-certification in “plan → code” loops.

The architecture replaces “hope the model stays aligned” with measurable invariants (schemas, gates, drift scores) and structural reliability (phase separation + independent verification).
