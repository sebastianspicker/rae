---
status: stable
owner: core
last_reviewed: 2026-08-04
source_of_truth: README.md
evidence_links: reference/claims/evidence-index.md
---

# Documentation index

Use the root [README](https://github.com/sebastianspicker/rae/blob/main/README.md) for purpose, requirements, installation,
common commands, repository structure, and current limitations.

## Start here

1. [Project scope](explanation/overview/project-scope.md)
2. [System overview](reference/architecture/system-overview.md)
3. [Repository map](reference/repo-map.md)
4. [Umbrella CLI](reference/cli/umbrella.md)
5. [Choose an execution model](how-to/choose-an-execution-model.md)

## Tutorials

- [Graph engineering with RAE](tutorials/graph-engineering-with-rae.md)
- [First pipeline](tutorials/first-pipeline.md)
- [Autonomous code change](tutorials/autonomous-code-change.md)
- [First Ralph run](tutorials/first-ralph-run.md)
- [First profile installation](tutorials/first-profile-install.md)

## How-to guides

- [Run a benchmark](how-to/run-a-benchmark.md)
- [Reproduce a result](how-to/reproduce-a-result.md)
- [Write a contract](how-to/write-a-contract.md)
- [Add a tool](how-to/add-a-tool.md)
- [Publish a sanitized profile](how-to/publish-a-sanitized-profile.md)

## Reference

- [Umbrella CLI](reference/cli/umbrella.md)
- [Orchestration CLI](reference/cli/orchestration.md)
- [Ralph CLI](reference/cli/ralph.md)
- [Repository hygiene CLI](reference/cli/repo-hygiene.md)
- [Module boundaries](reference/architecture/module-boundaries.md)
- [Artifact schemas](reference/contracts/artifact-schemas.md)
- [Execution profile 3.0](reference/contracts/execution-profile-v3.md)
- [Local graph and memory](reference/contracts/graph-memory.md)
- [Workflow 2.2](reference/contracts/workflow-v2.2.md)
- [Quality gates](reference/contracts/quality-gates.md)
- [Task specifications](reference/contracts/task-specs.md)
- [Safety boundaries](reference/invariants/safety-boundaries.md)
- [Terminology](reference/terminology.md)

Package-owned command details:

- [Orchestration package](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/README.md)
- [Orchestration runbook](https://github.com/sebastianspicker/rae/blob/main/packages/orchestration/docs/RUNBOOK.md)
- [Ralph package](https://github.com/sebastianspicker/rae/blob/main/packages/loops/ralph/README.md)
- [Co-author trailer cleaner](https://github.com/sebastianspicker/rae/blob/main/tools/repo-hygiene/coauthor-trailer-cleaner/README.md)

## Research and evidence

- [Benchmark catalog](research/benchmark-catalog.md)
- [Benchmark protocol](research/benchmark-protocol.md)
- [Frozen benchmark results](research/frozen-benchmark-results.md)
- [Claims ledger](reference/claims/claims-ledger.md)
- [Evidence index](reference/claims/evidence-index.md)
- [Assumptions register](reference/claims/assumptions-register.md)

Committed baseline results are scoped to their recorded task set and
environment. They do not establish behavior on arbitrary repositories.

## Explanation

- [Autonomous improvement boundary](explanation/autonomous-improvement-boundary.md)
- [Decision tree](explanation/overview/decision-tree.md)
- [Contracts and gates](explanation/science/contracts-and-gates.md)
- [Limitations](explanation/science/limitations.md)
- [Threats to validity](explanation/science/threats-to-validity.md)
- [Negative results](explanation/science/negative-results.md)

## Governance

- [Documentation policy](governance/documentation-policy.md)
- [Citation policy](governance/citation-policy.md)
- [Source quality policy](governance/source-quality-policy.md)
- [Release criteria](governance/release-criteria.md)
- [Review checklists](governance/review-checklists.md)

Repository-level contribution, security, support, governance, and release
procedures are in
[CONTRIBUTING.md](https://github.com/sebastianspicker/rae/blob/main/CONTRIBUTING.md),
[SECURITY.md](https://github.com/sebastianspicker/rae/blob/main/SECURITY.md),
[SUPPORT.md](https://github.com/sebastianspicker/rae/blob/main/SUPPORT.md),
[GOVERNANCE.md](https://github.com/sebastianspicker/rae/blob/main/GOVERNANCE.md), and
[RELEASING.md](https://github.com/sebastianspicker/rae/blob/main/RELEASING.md).

## Source note

- [Diataxis](reference/claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](reference/claims/bibliography.md#src-model-cards)
- [Datasheets](reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](reference/claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](reference/claims/bibliography.md#src-nosek-open-research)
