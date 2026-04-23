---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: ../../research/benchmark-protocol.md
evidence_links: ../../reference/claims/evidence-index.md
---

# Robustness and Generalization

Good results on one task family do not imply robust agent behavior in the wild.

## Robustness

Robustness asks whether performance survives controlled perturbations:

- context order changes
- formatting changes
- noisy but non-adversarial repository conditions
- stricter time or tool budgets

## Generalization

Generalization asks whether performance extends to:

- held-out tasks
- new repositories
- new tool adapters
- tasks with different failure distributions

## Why this matters here

Agent systems are especially prone to benchmark overfitting because they can
implicitly absorb task-specific rituals, repo-specific conventions, or judge
quirks while appearing generally capable.

## Repo policy implication

This is why the benchmark protocol distinguishes:

- `dev`
- `held-out`
- `stress`
- `ablation`

## Related dossier

- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- held-out performance is still not universal deployment evidence
- some robustness failures only appear under real operator pressure or tool
  drift

## Source note

- [Lost in the Middle](../../reference/claims/bibliography.md#src-lost-in-the-middle)
- [OpenAI on benchmark contamination](../../reference/claims/bibliography.md#src-openai-swebench-verified)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
