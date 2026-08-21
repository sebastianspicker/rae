---
status: experimental
owner: orchestration
last_reviewed: 2026-07-29
source_of_truth: packages/orchestration/contracts/graph
evidence_links: ../claims/evidence-index.md
---

# Local Graph and Memory Contracts

RAE can build four local graph projections: repository structure, workflow
state, run evidence, and cross-run memory. The feature is optional. Autonomous
runs use `--graph-memory off` unless an operator explicitly selects `read` or
`read-write`.

The graph augments retrieval and explanations. It does not replace artifacts,
`trace.jsonl`, gates, checkpoints, policies, evaluator code, Git state, or plan
ownership.

## Storage

One run projection is stored under:

```text
.pipeline/runs/<run-id>/graph/
  manifest.json
  nodes.jsonl
  edges.jsonl
  contexts/<phase>.json
```

Repository-only builds use a stable synthetic run ID derived from the current
snapshot. Cross-run memory is stored outside the public worktree in the target
repository's Git common directory at `<git-common-dir>/rae-memory/v1/`.

Graph and memory files use owner-only permissions, atomic replacement, and an
exclusive memory lock. Human promotion, rejection, supersession, and
invalidation records are append-only. Projections and admitted facts are
rebuildable from source artifacts.

Repository identity is the SHA-256 digest of the canonical Git common
directory. Snapshot identity combines the `HEAD` tree digest with a digest of
the dirty overlay. Runtime files under `.pipeline/` do not affect that overlay.

## Record model

Node, edge, manifest, context, and memory-decision schemas live under
`packages/orchestration/contracts/graph/`. Every node and edge records its
graph family, repository and run namespace, stable logical ID,
content-addressed version ID, source reference and digest, projector version,
transaction time, validity interval, and trust class.

Trust classes are enforced as filters:

- `authoritative` covers repository-owned contracts, Git identity, captured
  commands, gates, and human decisions
- `verified-derived` covers deterministic relations reconstructed from those
  sources
- `model-proposed` covers relations extracted from model-authored artifacts
- `untrusted` covers quarantined or conflicting memory candidates

The provenance fields are a compact JSON profile informed by
[W3C PROV-O](https://www.w3.org/TR/prov-o/). RAE does not add RDF storage or an
external graph service.

## Repository projection

The projector reads tracked regular files and plan-owned changed or new files.
It excludes symlinks, submodules, binaries, credential-like paths, `.pipeline`
state, files outside the canonical repository, and files larger than 1 MiB.

Dependency-free extractors record exact literal path relationships for JSON,
TOML, JavaScript module syntax, CommonJS, shell sourcing, and Markdown links.
Python imports are parsed with the required Python runtime's standard `ast`
module. Unsupported languages retain file and exact-reference relationships.
The projector does not infer authoritative symbol, call, or data-flow edges.

Builds fail closed for orphan edges, duplicate IDs, unresolved sources, digest
mismatches, invalid validity intervals, cross-repository records, malformed
JSONL, or configured size bounds. Completed-run projections additionally
require every MUST requirement to reach a plan task, test case, captured
command, and gate decision.

## Retrieval

Queries rank exact paths and identifiers first, then lexical overlap, then
bounded graph distance. Trust and current-source validity are hard filters.
Each result includes its source reference, digest, selection reason, traversal
path, score components, staleness status, and source snippet.

Traversal depth is limited to four, output is limited to 200 records, source
files are limited to 1 MiB, and projections are limited to 250,000 nodes and
1,000,000 edges. Autonomous phase retrieval currently requests at most 50 run
records and 50 admitted memory records. A limit or validation failure stops the
opted-in graph operation. The default non-graph workflow remains available.

## Temporal memory

`read` retrieves only current `authoritative` and `verified-derived` facts from
the same repository identity. `read-write` also imports successful recorded
outcomes and quarantines model-proposed candidates after run completion.

Changed facts are superseded rather than overwritten. Retrieval excludes
rejected, superseded, invalidated, stale, conflicting, and cross-repository
facts. Promotion requires a candidate ID, actor, rationale, and a safe
repository-relative corroborating source. Rejection preserves the candidate
and decision.

Memory does not broaden plan ownership, provider access, mutation scope, or
publication authority.

## CLI

```bash
./scripts/rae.sh graph build --project-root /path/to/repository
./scripts/rae.sh graph status --project-root /path/to/repository
./scripts/rae.sh graph query --project-root /path/to/repository \
  --seed 'File:src/main.js'
./scripts/rae.sh graph explain --project-root /path/to/repository \
  --run-id <id> --node 'Requirement:REQ-001'
./scripts/rae.sh graph memory list --project-root /path/to/repository
```

Use `--json` for the contract-defined representation. Human-readable key/value
output is the default.

## Threat model

The primary risks are prompt injection in source text, memory poisoning, stale
facts, high-degree hub manipulation, topology fabricated by a model, protected
path ingestion, and cross-project leakage. RAE limits these risks through exact
extractors, source digests, repository namespaces, hard trust filters,
quarantine, bounded traversal, credential-path exclusion, and source snippets.

Graph text remains untrusted input to a provider. Operators must not treat a
relationship or summary as authorization. Raw prompts, provider metadata,
absolute paths, untrusted memory text, and unrestricted queries are excluded
from the operator API. The operator receives only health counts.

## Experimental status

The projection and safety contracts have deterministic local tests. Graph-
informed execution remains experimental until it has production-oriented
integration evidence showing that it preserves repository and protected-path
boundaries without degrading operator control. No such result is claimed by
this contract page.

The design is informed by evidence that graph retrieval is useful for
relational and repository-structure questions but is not uniformly better than
strong flat retrieval. See [GraphRAG-Bench](https://graphrag-bench.github.io/),
[CodexGraph](https://aclanthology.org/2025.naacl-long.7/),
[RepoGraph](https://arxiv.org/abs/2410.14684), and
[Does Memory Need Graphs?](https://aclanthology.org/2026.acl-long.1232/).
Temporal and security boundaries are informed by
[Graphiti](https://arxiv.org/abs/2501.13956),
[GraphRAG under Fire](https://arxiv.org/abs/2501.14050), and
[LongMemEval-V2](https://arxiv.org/abs/2605.12493).

## Current limitations

- Rich language-specific symbol and call graphs require a future adapter.
- Memory promotion is a local CLI operation, not an operator-console control.
- The operator exposes health counts but no unrestricted graph browser.
- Benchmark thresholds must be satisfied before graph execution can leave
  experimental status.

## Source note

- [W3C PROV-O](../claims/bibliography.md#src-w3c-prov-o)
- [GraphRAG-Bench](../claims/bibliography.md#src-graphrag-bench)
- [CodexGraph](../claims/bibliography.md#src-codexgraph)
- [RepoGraph](../claims/bibliography.md#src-repograph)
- [Does Memory Need Graphs?](../claims/bibliography.md#src-does-memory-need-graphs)
- [Graphiti](../claims/bibliography.md#src-graphiti)
- [GraphRAG under Fire](../claims/bibliography.md#src-graphrag-under-fire)
- [LongMemEval-V2](../claims/bibliography.md#src-longmemeval-v2)
