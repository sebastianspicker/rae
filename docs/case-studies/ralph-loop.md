---
status: historical
owner: loops
last_reviewed: 2026-07-16
source_of_truth: editorial
evidence_links: ../reference/repo-map.md
---

# Case Study: Ralph Loop

Ralph `0.3.0` is a Codex-only deterministic loop for bounded, story-scoped work.

## What it contributes

- read-only audit and linting, plus transactional story-scoped fixing
- journaled transaction handling and crash recovery
- deterministic story selection
- scope enforcement for fixing runs
- bounded Codex deadline and output capture
- a strong regression suite for loop invariants

## Why it matters to the umbrella

It shows that agent work can stay reproducible and bounded without a large
multi-stage orchestration graph.

## Thesis validation

Ralph is the bounded deterministic-loop surface: it selects a story, confines
the change to approved paths, journals each transaction, and recovers from a
crash without relying on a multi-stage graph.

## Interpretation limits

- this page is a case interpretation, not a benchmark card or result report

## Source note

- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Conway 1968](../reference/claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../reference/claims/bibliography.md#src-brooks-no-silver-bullet)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
