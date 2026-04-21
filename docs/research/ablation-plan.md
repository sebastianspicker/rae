---
status: experimental
owner: evals
last_reviewed: 2026-04-12
source_of_truth: evals
evidence_links: benchmark-protocol.md
---

# Ablation Plan

The point of ablations is to identify which control surfaces matter, not merely
to generate more numbers.

## Planned ablation axes

- staged vs unstaged workflows
- gated vs ungated progression
- deterministic loop constraints on vs off
- narrow vs wide context allocation
- extra reviewer fan-out on vs off
- stricter provenance enforcement on vs off

## Reporting rule

An ablation should state what changed, what stayed fixed, and whether the
observed difference was large enough to matter operationally.

## Thesis validation

This page supports the claim that architecture and workflow doctrines should be
stress-tested by controlled subtraction rather than protected by one favored
configuration.

## Related dossiers

- [CLM-014 staged separation](../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-016 cognitive tiering](../reference/claims/dossiers/clm-016-cognitive-tiering.md)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- no ablation result should be overread without sample-size, validity, and
  contamination context

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
