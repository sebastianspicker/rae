---
status: stable
owner: core
last_reviewed: 2026-04-28
source_of_truth: docs
evidence_links: reference/claims/evidence-index.md
---

# Documentation Index

## Reading order

If you are new to the repo, read in this order:

1. [Project Scope](explanation/overview/project-scope.md)
2. [System Overview](reference/architecture/system-overview.md)
3. [Decision Tree](explanation/overview/decision-tree.md)
4. [Claims Ledger](reference/claims/claims-ledger.md)
5. [Benchmark Protocol](research/benchmark-protocol.md)
6. [Frozen Benchmark Results](research/frozen-benchmark-results.md)
7. [Documentation Policy](governance/documentation-policy.md)

## Maintainer orientation

For code work, start with the public entrypoints before reading individual
modules:

- `README.md` explains why the repo exists and which surface owns each layer.
- [Repo Map](reference/repo-map.md) maps directories to responsibilities.
- [Umbrella CLI](reference/cli/umbrella.md) maps operator commands to the
  imported runtimes.
- [Module Boundaries](reference/architecture/module-boundaries.md) explains
  which module owns behavior when docs and package-local instructions overlap.

## Documentation modes

- `tutorials/`
  Guided first runs with concrete commands.
- `how-to/`
  Task-oriented operating instructions.
- `reference/`
  Stable contracts, invariants, schemas, and terminology.
- `explanation/`
  Scientific rationale, limits, and theory.
- `research/`
  Benchmark doctrine, cards, calibration, and reporting.
- `governance/`
  Review policy, citation rules, and release gates.

## Scientific core

- [Abstract](explanation/science/abstract.md)
- [Problem Statement](explanation/science/problem-statement.md)
- [Notation](explanation/supplementary/notation.md)
- [Formal Model](explanation/supplementary/formal-model.md)
- [Information Theory](explanation/science/information-theory.md)
- [Coordination Cost](explanation/science/coordination-cost.md)
- [Drift and Self-Certification](explanation/science/drift-and-self-certification.md)
- [Contracts and Gates](explanation/science/contracts-and-gates.md)
- [Threats to Validity](explanation/science/threats-to-validity.md)
- [Limitations](explanation/science/limitations.md)
- [Negative Results](explanation/science/negative-results.md)

## Thesis validation rule

Every article in `docs/` should now be read as part of one auditable companion
volume:

- local behavior remains anchored in code, schemas, benchmark artifacts, and
  package-local docs
- cross-page theses resolve to claim dossiers and companion proof surfaces
- each article carries an external source packet so the broader rationale is
  inspectable rather than implied

## Source note

- [Diataxis](reference/claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](reference/claims/bibliography.md#src-model-cards)
- [Datasheets](reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](reference/claims/bibliography.md#src-openai-paperbench)

## Operational core

- [Umbrella CLI](reference/cli/umbrella.md)
- [Workflow Rubric](reference/workflow-rubric.md)
- [Choose an Execution Model](how-to/choose-an-execution-model.md)
- [Run a Benchmark](how-to/run-a-benchmark.md)
- [First Profile Install](tutorials/first-profile-install.md)
- [Reproduce a Result](how-to/reproduce-a-result.md)
- [Write a Contract](how-to/write-a-contract.md)
- [Add a Tool](how-to/add-a-tool.md)
- [Task Specs](reference/contracts/task-specs.md)
- [Human Checkpoints](reference/contracts/human-checkpoints.md)
- [Result Ledger](reference/contracts/result-ledger.md)
- [Frozen Benchmark Results](research/frozen-benchmark-results.md)

## Governing surfaces

- `AGENTS.md`
  Shared workflow memory, escalation defaults, and umbrella execution rules.
- `CONTRIBUTING.md`
  Repository contribution and change-handling expectations.
- `SECURITY.md`
  Supported scope, reporting route, and disclosure handling expectations.

## Imported module docs

- `packages/orchestration/README.md`
- `packages/orchestration/docs/INDEX.md`
- `packages/loops/ralph/README.md`
- `tools/repo-hygiene/coauthor-trailer-cleaner/README.md`

These package-local docs remain the command-level source of truth. The umbrella
docs explain how the modules fit together and how claims about them should be
measured and documented.
