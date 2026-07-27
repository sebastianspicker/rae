---
status: stable
owner: core
last_reviewed: 2026-07-19
source_of_truth: editorial
evidence_links: bibliography.md
---

# Evidence Index

## Claim mappings

### CLM-002

- Dossier: [CLM-002 diataxis separation](dossiers/clm-002-diataxis-separation.md)
- Internal anchor: `docs/INDEX.md`
- Internal anchor: `docs/governance/documentation-policy.md`
- External anchor: [Diataxis](bibliography.md#src-diataxis)

### CLM-003

- Dossier: [CLM-003 benchmark provenance](dossiers/clm-003-benchmark-provenance.md)
- Internal anchor: `docs/research/benchmark-protocol.md`
- Internal anchor: `evals/schemas/benchmark-card.schema.json`
- Internal anchor: `evals/schemas/run-card.schema.json`
- External anchor: [OpenAI evals guidance](bibliography.md#src-openai-evals)

### CLM-004

- Dossier: [CLM-004 repo audit benchmark](dossiers/clm-004-repo-audit-benchmark.md)
- Internal anchor: `packages/loops/ralph/README.md`
- Internal anchor: `docs/reference/invariants/determinism-contracts.md`
- Internal anchor: `evals/benchmarks/repo-audit-core.benchmark-card.json`
- Internal anchor: `evals/results/baselines/repo-audit-core-dev.json`
- Internal anchor: `evals/results/baselines/repo-audit-core-held-out.json`

### CLM-005

- Dossier: [CLM-005 utility placement](dossiers/clm-005-utility-placement.md)
- Internal anchor: `tools/repo-hygiene/coauthor-trailer-cleaner/README.md`
- Internal anchor: `docs/reference/architecture/module-boundaries.md`
- Internal anchor: `profiles/agent-environments/README.md`

### CLM-006

- Dossier: [CLM-006 benchmark contamination](dossiers/clm-006-benchmark-contamination.md)
- Internal anchor: `docs/research/benchmark-protocol.md`
- External anchor: [OpenAI on SWE-bench contamination and flawed tests](bibliography.md#src-openai-swebench-verified)
- External anchor: [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)

### CLM-007

- Dossier: [CLM-007 information density](dossiers/clm-007-information-density.md)
- Internal anchor: `docs/explanation/science/information-theory.md`
- External anchor: [Transformer](bibliography.md#src-transformer)
- External anchor: [Lost in the Middle](bibliography.md#src-lost-in-the-middle)
- External anchor: [GPT-3 few-shot learners](bibliography.md#src-gpt3)

### CLM-008

- Dossier: [CLM-008 coordination topology](dossiers/clm-008-coordination-topology.md)
- Internal anchor: `docs/explanation/science/coordination-cost.md`
- Internal anchor: `packages/orchestration/docs/ORCHESTRATION_POLICY.md`
- External anchor: [Amdahl 1967](bibliography.md#src-amdahl-1967)
- External anchor: [Conway 1968](bibliography.md#src-conway-1968)
- External anchor: [Cataldo et al.](bibliography.md#src-cataldo-congruence)

### CLM-009

- Dossier: [CLM-009 judge calibration](dossiers/clm-009-judge-calibration.md)
- Internal anchor: `docs/research/judge-calibration.md`
- Internal anchor: `docs/explanation/supplementary/judge-reliability.md`
- External anchor: [G-Eval](bibliography.md#src-g-eval)

### CLM-010

- Dossier: [CLM-010 reproducibility layers](dossiers/clm-010-reproducibility-layers.md)
- Internal anchor: `docs/explanation/supplementary/reproducibility.md`
- Internal anchor: `docs/reference/invariants/provenance-requirements.md`
- External anchor: [Model Cards](bibliography.md#src-model-cards)
- External anchor: [Datasheets](bibliography.md#src-datasheets)

### CLM-014

- Dossier: [CLM-014 staged separation](dossiers/clm-014-staged-separation.md)
- Internal anchor: `docs/explanation/science/problem-statement.md`
- Internal anchor: `docs/explanation/science/drift-and-self-certification.md`
- Internal anchor: `packages/orchestration/scripts/pipeline/runner.mjs`
- Internal anchor: `packages/orchestration/scripts/pipeline/autonomous.mjs`
- Regression evidence: `packages/orchestration/scripts/pipeline/tests/autonomous-core-scenarios.test.mjs`
- Regression evidence: `packages/orchestration/scripts/pipeline/tests/autonomous-checkpoint-scenarios.test.mjs`
- External anchor: [Anthropic effective agents](bibliography.md#src-anthropic-effective-agents)
- External anchor: [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- External anchor: [PaperBench](bibliography.md#src-openai-paperbench)

### CLM-015

- Dossier: [CLM-015 contract-gate distinction](dossiers/clm-015-contract-gate-distinction.md)
- Internal anchor: `docs/explanation/science/contracts-and-gates.md`
- Internal anchor: `docs/reference/contracts/quality-gates.md`
- Internal anchor: `evals/schemas/*.json`
- External anchor: [IEEE 1012](bibliography.md#src-ieee-1012)
- External anchor: [Model Cards](bibliography.md#src-model-cards)
- External anchor: [Datasheets](bibliography.md#src-datasheets)

### CLM-016

- Dossier: [CLM-016 cognitive tiering](dossiers/clm-016-cognitive-tiering.md)
- Internal anchor: `docs/explanation/science/cognitive-tiering.md`
- Internal anchor: `docs/explanation/supplementary/design-axioms.md`
- External anchor: [Kahneman](bibliography.md#src-kahneman-fast-slow)
- External anchor: [Bainbridge automation](bibliography.md#src-bainbridge-automation)
- External anchor: [Parasuraman and Riley](bibliography.md#src-parasuraman-riley)

### CLM-017

- Dossier: [CLM-017 documentation reliability](dossiers/clm-017-documentation-reliability.md)
- Internal anchor: `docs/governance/documentation-policy.md`
- Internal anchor: `docs/explanation/science/abstract.md`
- Internal anchor: `scripts/verify_repo.py`
- External anchor: [Diataxis](bibliography.md#src-diataxis)
- External anchor: [Nosek open research culture](bibliography.md#src-nosek-open-research)
- External anchor: [Pineau reproducibility report](bibliography.md#src-pineau-reproducibility)

### CLM-019

- Dossier: [CLM-019 validity doctrine](dossiers/clm-019-validity-doctrine.md)
- Internal anchor: `docs/explanation/science/threats-to-validity.md`
- Internal anchor: `docs/research/benchmark-protocol.md`
- Internal anchor: `docs/governance/review-checklists.md`
- External anchor: [OpenAI on SWE-bench contamination](bibliography.md#src-openai-swebench-verified)
- External anchor: [PaperBench](bibliography.md#src-openai-paperbench)
- External anchor: [Artstein and Poesio](bibliography.md#src-artstein-poesio)

### CLM-020

- Dossier: [CLM-020 layered failure model](dossiers/clm-020-layered-failure-model.md)
- Internal anchor: `docs/explanation/supplementary/model-of-failure.md`
- Internal anchor: `docs/explanation/science/drift-and-self-certification.md`
- External anchor: [Lost in the Middle](bibliography.md#src-lost-in-the-middle)
- External anchor: [Cataldo et al.](bibliography.md#src-cataldo-congruence)
- External anchor: [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)

### CLM-021

- Dossier: [CLM-021 negative results](dossiers/clm-021-negative-results.md)
- Internal anchor: `docs/explanation/science/negative-results.md`
- Internal anchor: `docs/research/result-report-template.md`
- External anchor: [Nosek open research culture](bibliography.md#src-nosek-open-research)
- External anchor: [Pineau reproducibility report](bibliography.md#src-pineau-reproducibility)
- External anchor: [Smaldino bad science](bibliography.md#src-smaldino-bad-science)

### CLM-011

- Dossier: [CLM-011 explicit routing](dossiers/clm-011-explicit-routing.md)
- Internal anchor: `scripts/rae.sh`
- Internal anchor: `evals/scripts/router.py`
- Internal anchor: `docs/reference/contracts/task-specs.md`

### CLM-012

- Dossier: [CLM-012 benchmark interpretability](dossiers/clm-012-benchmark-interpretability.md)
- Internal anchor: `evals/scripts/run_benchmark.py`
- Internal anchor: `evals/scripts/judge_calibration.py`
- Internal anchor: `docs/research/benchmark-protocol.md`
- Internal anchor: `docs/research/judge-calibration.md`
- Internal anchor: `docs/research/frozen-benchmark-results.md`

### CLM-013

- Dossier: [CLM-013 release gate](dossiers/clm-013-release-gate.md)
- Internal anchor: `evals/scripts/release_gate.py`
- Internal anchor: `docs/governance/release-criteria.md`
- Internal anchor: `docs/reference/contracts/human-checkpoints.md`
- Internal anchor: `docs/reference/contracts/result-ledger.md`

## Evidence classes

- `internal anchor`
  Code, schema, or doc surface inside this repo.
- `external anchor`
  Primary external source informing method, interpretation, or policy.
- `benchmark artifact`
  Frozen run output or scorecard under `evals/results/`.

## Publication rule

Repo policy claims may rely heavily on internal anchors. Broader scientific,
benchmark, or methodological claims should additionally resolve to external
anchors or benchmark artifacts.

## Source note

- [NIST GenAI Profile](bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](bibliography.md#src-openai-evals)
- [PaperBench](bibliography.md#src-openai-paperbench)
- [Model Cards](bibliography.md#src-model-cards)
- [Datasheets](bibliography.md#src-datasheets)
- [Artstein and Poesio](bibliography.md#src-artstein-poesio)
- [IEEE 1012](bibliography.md#src-ieee-1012)
