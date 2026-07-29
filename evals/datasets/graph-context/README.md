# Frozen graph-context retrieval tasks

`graph-context-held-out.json` contains 50 repository-localization tasks frozen
on 2026-07-29. Each task has a natural-language query and one or more expected
repository paths.

Run the dependency-free comparison from the repository root:

```bash
npm --prefix packages/orchestration run benchmark:graph-context -- \
  --project-root "$PWD" \
  --output /tmp/rae-graph-context-result.json
```

The runner compares path-only current context, lexical retrieval, lexical plus
the repository/evidence graph, and graph retrieval plus promoted memory. It
records Recall@10, estimated context tokens, retrieval latency, projection
time, stale-context rate, leakage, agent calls, and cost.

This retrieval-only task set does not execute a provider and therefore cannot
measure held-out task pass count. The result keeps that field `null` and cannot
move graph execution out of experimental status. Provider-backed task success,
100,000-node latency, and 10,000-file projection fixtures remain separate
release evidence requirements.
