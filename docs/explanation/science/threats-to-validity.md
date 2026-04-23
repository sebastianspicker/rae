---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Threats to Validity

This page supports the rule that reliability claims must be interpreted together
with explicit validity threats.

## Benchmark threats

- contamination from public tasks or solutions
- narrow tests that reject correct solutions
- wide tests that require unspecified behavior
- dev-set overfitting disguised as general capability

## Judge threats

- rubric ambiguity
- model judge drift across versions
- silent changes in prompting or calibration
- weak agreement against stronger references

## Documentation threats

- reference pages becoming opinion pages
- explanation pages inheriting false authority
- implementation drift outrunning documentation review

## Model and workflow threats

- context-selection heuristics may not transfer across task families
- coordination benefits can reverse when the merge surface is weak
- stage boundaries can add delay or bureaucracy without measurable gain

## Sampling threats

- imported source repos may not represent the full design space
- benchmark families can overweight tasks that match the current architecture

## Interpretation rule

A publishable claim should identify at least:

- what was sampled
- what was not sampled
- which measurement surfaces might have drifted
- where contamination or rubric weakness could distort interpretation

Any strong claim about reliability should be read together with this page and
[Limitations](limitations.md).

## Claim dossier

- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Source note

- [OpenAI on SWE-bench contamination](../../reference/claims/bibliography.md#src-openai-swebench-verified)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [G-Eval](../../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
