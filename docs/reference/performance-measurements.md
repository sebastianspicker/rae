---
status: experimental
owner: core
last_reviewed: 2026-09-08
source_of_truth: scripts/src/benchmarks
evidence_links: ../assets/benchmarks/typescript-rewrite-2026-09-08.json
---

# Local performance measurements

These measurements characterize the TypeScript implementation in a dirty local
checkout on macOS arm64 with Node 26.8.1. Each workload has seven samples. They
do not establish release performance or cross-platform results. The
[raw measurements](../assets/benchmarks/typescript-rewrite-2026-09-08.json)
include latency distributions, memory observations, event-loop measurements,
read and parsing counters, and result hashes.

## Run catalog

The workload requests the first 100 detailed public run projections from
disposable catalogs containing 100, 1,000 and 10,000 runs. The retained
JavaScript implementation discovers and hydrates the catalog before slicing.
The compiled implementation reconciles summaries and hydrates the selected
page in a worker. Public result hashes match at all three sizes.

| Runs | Reference median, ms | Worker median, ms | Reference warm JSON parses | Worker warm JSON parses |
| --- | ---: | ---: | ---: | ---: |
| 100 | 1,901 | 6,958 | 201 | 201 |
| 1,000 | 18,214 | 6,998 | 2,001 | 201 |
| 10,000 | 188,858 | 7,516 | 20,001 | 201 |

The 100-run workload regressed in latency. Warm parsing work remains constant
for the selected page, but catalog reconciliation still examines filesystem
metadata. The reference and worker runs occurred at different times on a
shared workstation, so these timings do not isolate the effect of each code
change. The original catalog event-loop delay sampler missed synchronous
blocking; its delay values must not be used for comparison. Later samples add
an explicit timer-lateness measurement.

## Concurrent event replay

The workload replays the same trace for 100 clients, with either one or ten
starting-cursor groups. It compares full replay per client with shared bounded
subscriptions in the same process. It does not include HTTP or network latency.
Every client's result hash matches across implementations.

| Events | Cursor groups | Full replay median, ms | Batched subscriptions median, ms |
| --- | ---: | ---: | ---: |
| 1,000 | 1 | 91 | 72 |
| 1,000 | 10 | 76 | 63 |
| 10,000 | 1 | 947 | 721 |
| 10,000 | 10 | 784 | 646 |

An earlier shared implementation repeated filesystem authorization for each
cursor page and was slower than full replay. Its measurements remain in the
data file. The current reader validates one protected snapshot for a bounded
batch of cursor requests. Cache hits avoid reparsing historical records;
changed files still require content validation. Backpressure and cancellation
are verified separately by operator tests.

## Graph queries

Each sample executes nine queries over a 512-file import chain or a 513-file
fan-out graph, with exact and lexical seeds, depth four and a 20-record result
limit. Reference and compiled query results have identical hashes. Median
batch times were 358 versus 355 ms for the deep graph, and 357 versus 354 ms
for the wide graph. These small differences do not substantiate a latency
improvement.

Both implementations performed 18 graph-content digest checks per sample.
The compiled implementation built one adjacency index and reused it eight
times, and built one lexical index. Queries remain synchronous and blocked
the measuring event loop for roughly the batch duration.

## Reproduction and limits

Build the repository before running these compiled tools:

```text
node scripts/dist/benchmarks/operator.js --module apps/operator/dist/lib/catalog.js --mode compiled --sizes 100,1000,10000 --iterations 7
node scripts/dist/benchmarks/event-streams.js
node packages/engine/dist/scripts/benchmark-graph.js
```

The operator benchmark accepts explicit module, mode, size and iteration
arguments. Graph comparison accepts `--reference <query-module-path>` while
the retained reference source is available. All fixture repositories are
disposable; benchmark commands do not rewrite the working repository.

The sample count is small. The reported 95th percentile is the largest of
seven samples. RSS before/after observations include the whole process, and
the process maximum is cumulative across samples. Graph read counters cover
graph-cache content reads, not every filesystem operation. Linux, Node 24,
network-stream and disposable database/storage performance lanes remain unrun.
