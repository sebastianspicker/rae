---
status: stable
owner: core
last_reviewed: 2026-07-16
source_of_truth: README.md
evidence_links: ../claims/evidence-index.md
---

# System Overview

RAE, short for Reliable Agentic Engineering, is organized as an evidence loop, not only a code
tree.

```mermaid
flowchart LR
  A[Task or operator need] --> B[Choose execution model]
  B --> C[Run orchestration or deterministic loop]
  C --> D[Emit artifacts and gates]
  D --> E[Benchmark or verify]
  E --> F[Publish claim with provenance]
  F --> G[Docs and release review]
  G --> H[Reusable reference implementation]
```

## Architectural layers

1. `packages/orchestration/`
   Use when work is long-horizon, stageable, and benefits from explicit
   handoffs, typed artifacts, and gated progression. Its autonomous executor
   launches real coding-agent sessions; its low-level runner remains available
   for manual artifact and gate control.
2. `packages/loops/ralph/`
   Ralph `0.3.0` is Codex-only. Use it for deterministic story-sized audit,
   linting, or transactional fixing runs with strict mode control.
3. `tools/repo-hygiene/`
   Use for narrow, explicit maintenance operations that should not be mistaken
   for the core runtime architecture.
4. `evals/`
   Stores benchmark metadata, scenarios, run cards, schemas, and result
   artifacts.
5. `docs/`
   Explains the system, records its limits, and constrains what may be claimed.
6. `profiles/agent-environments/`
   Public machine-agnostic publication lane for portable operator
   environments. The current committed surface defines policy and boundaries;
   sanitized payloads land here only after extraction. Manifest v2 uses
   no-follow filesystem operations and retained recovery evidence.

## Integration rule

The modules are not merged by erasing their identities. They are integrated by
sharing:

- terminology
- claim and evidence policy
- benchmark metadata
- release criteria
- operator workflow guidance

## Primary operator path

1. Use [Choose an Execution Model](../../how-to/choose-an-execution-model.md)
   to decide whether the task needs orchestration, a deterministic loop, or a
   narrow tool.
2. Start from the umbrella harness: `./scripts/rae.sh`.
3. Dispatch into the selected runtime locally. For autonomous delivery, use
   `./scripts/rae.sh agent run ...`; for manual stage control, use
   `./scripts/rae.sh orchestrate ...`.
4. Record the resulting artifacts, gates, or reports.
5. If the result is used for comparison or publication, register it through the
   `evals/` metadata model.
6. Update claim-bearing docs only after evidence and provenance are available.

## Artifact flow

RAE treats artifacts as the boundary between doing work and claiming that the
work is reliable. The important artifact families are:

- `.pipeline/runs/<run-id>/`
  Orchestration state, traces, stage artifacts, gates, review-loop state, and
  progress summaries.
- `evals/results/`
  Benchmark run cards, command-result transcripts, regression reports, release
  gate reports, and result ledgers.
- `profiles/agent-environments/`
  Sanitized operator profile material and installation regression fixtures.

New code should either produce one of these artifacts, validate one of these
artifacts, or stay inside the package-local runtime that owns the behavior.

## Thesis validation

This page validates the architectural thesis that RAE is an evidence loop rather
than a pile of disconnected modules. The supporting proof is structural:
explicitly separated modules, shared publication doctrine, and traceable claims.

## Related dossiers

- [CLM-014 staged separation](../claims/dossiers/clm-014-staged-separation.md)
- [CLM-017 documentation reliability](../claims/dossiers/clm-017-documentation-reliability.md)

## Interpretation limits

- this diagram is explanatory architecture, not empirical proof of universal
  superiority over other designs

## Source note

- [Conway 1968](../claims/bibliography.md#src-conway-1968)
- [Brooks no silver bullet](../claims/bibliography.md#src-brooks-no-silver-bullet)
- [Olson and Olson](../claims/bibliography.md#src-olson-olson)
- [Herbsleb and Mockus](../claims/bibliography.md#src-herbsleb-mockus)
- [Cataldo et al.](../claims/bibliography.md#src-cataldo-congruence)
- [Anthropic effective agents](../claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
