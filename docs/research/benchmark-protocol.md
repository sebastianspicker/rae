---
status: stable
owner: evals
last_reviewed: 2026-07-19
source_of_truth: evals
evidence_links: ../reference/invariants/provenance-requirements.md
---

# Benchmark Protocol

This repository treats benchmark design as a first-class engineering problem.

## Every benchmark family must define

- benchmark identifier and version
- research question
- benchmark intent or hypothesis
- scenario family and task source
- sampling logic and why the chosen splits represent the intended workload
- executable task spec bundle
- frozen dev and held-out baseline artifacts
- split policy
- success metric and failure classes
- judge type and calibration plan
- comparison baseline or comparison rule
- contamination risk notes
- external-validity limits
- cost and latency capture
- publication constraints
- regression policy
- release gate policy

## Research question and benchmark intent

Every benchmark family should say what it is trying to learn before it says how
to run. At minimum, record:

- the operator or research question
- whether the benchmark is for regression tracking, system comparison, release
  gating, or broader empirical claims
- the hypothesis or benchmark intent, if one exists
- which claims the benchmark is not strong enough to support

## Split policy

At minimum, results should distinguish:

- `dev`
- `held-out`
- `stress` or `adversarial`
- `ablation`

Held-out results should never be merged into development summaries without
explicit labeling.

Document why the split design exists. A benchmark family should explain what the
`dev` split is allowed to optimize, what the `held-out` split protects, and how
stress or ablation splits change interpretation.

## Judge and measurement policy

Every benchmark family should declare:

- judge identifier, version, and rubric version
- calibration set or calibration procedure when one exists
- whether uncertainty analysis is required for the family, and if not, why not
- how failure classes map to the headline metric
- how comparisons to the baseline are computed and interpreted

## Contamination policy

Public benchmark tasks are useful but insufficient.

When tasks are public or derived from public repos, result interpretation should
explicitly discuss:

- possible training exposure
- task or solution leakage
- whether the benchmark is mainly for regression tracking or for external
  capability claims
- what distribution shift or sampling bias remains after mitigation

## Result policy

No benchmark result is publishable in this repo without:

- benchmark question or intent statement
- benchmark card
- run card
- result ledger entry
- regression report
- release gate report
- verification evidence summary when review quality depends on proof artifacts
- frozen runtime and judge versions
- comparison baseline or explicit statement that no baseline applies
- failure summary
- interpretation block with residual uncertainty and threats to validity
- provenance fields required by
  [Provenance Requirements](../reference/invariants/provenance-requirements.md)

When the benchmarked behavior affects a user-facing surface, include a user
surface probe or screenshot artifact in the run evidence instead of relying on
command status alone.

## Artifact retention rule

Published result interpretation should remain auditable after the run is over.
Retain the benchmark card, run card, result ledger, release gate, regression
report, verification summary, baseline reference, and any screenshots, traces,
or probes needed to inspect operator-visible behavior.

## Release-gate rule in this repo

Release-gated benchmark families must be rerunnable through the local
verification matrix. In RAE that means the frozen benchmark suite is executed in
`./scripts/verify.sh` for `dev` and `held-out` splits.

## Thesis validation

This page expresses a methods claim: benchmark publication is only interpretable
when task identity, split design, judge behavior, provenance, contamination
handling, and retained artifacts are all visible.

## Related dossiers

- [CLM-003 benchmark publication metadata](../reference/claims/evidence-index.md#clm-003)
- [CLM-019 validity doctrine](../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Interpretation limits

- the protocol defines publication adequacy, not a guarantee that one benchmark
  family captures all relevant capability

## Source note

- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [OpenAI on SWE-bench contamination](../reference/claims/bibliography.md#src-openai-swebench-verified)
- [G-Eval](../reference/claims/bibliography.md#src-g-eval)
- [Artstein and Poesio](../reference/claims/bibliography.md#src-artstein-poesio)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
