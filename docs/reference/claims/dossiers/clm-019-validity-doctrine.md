---
status: stable
owner: evals
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-019
---

# CLM-019 Validity Doctrine

## Claim statement

Reliability and benchmark claims require explicit threats-to-validity,
contamination, and uncertainty analysis before publication-strength
interpretation.

## Claim class

`governance_rule`

## Proof mode

Evaluation and measurement doctrine grounded in benchmark, judging, and
reproducibility literature.

## Assumptions

- benchmark artifacts are always partial representations of the target workload
- judge and rubric changes can change measured outcomes
- contamination and sampling error can dominate apparent gains

## Internal anchors

- `docs/explanation/science/threats-to-validity.md`
- `docs/research/benchmark-protocol.md`
- `docs/governance/review-checklists.md`

## External anchors

- [OpenAI on SWE-bench contamination](../bibliography.md#src-openai-swebench-verified)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [G-Eval](../bibliography.md#src-g-eval)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)

## Benchmark artifacts

- `evals/results/`
- `docs/research/frozen-benchmark-results.md`

## Counterarguments

- lightweight internal comparisons may not need the full publication stack
- too much validity discussion can obscure a simple operational result

## Validity threats

- validity doctrine can become performative if it is not tied to release gates
- some risks remain unknowable before deployment or broader sampling

## Review status

Adopted as a publication rule.

## Source note

- [OpenAI on SWE-bench contamination](../bibliography.md#src-openai-swebench-verified)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [G-Eval](../bibliography.md#src-g-eval)
- [Artstein and Poesio](../bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
