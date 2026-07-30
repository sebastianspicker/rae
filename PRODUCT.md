# Product register

RAE is a source-distributed toolkit for bounded repository change, repair, and evaluation. Its supported autonomous provider is Codex. It operates on a committed Git repository in an isolated worktree by default and does not commit, push, publish, deploy, or promote workflow revisions.

The graph-native runtime treats a versioned workflow as executable policy. Requirements, design criticism, planning, alignment, mutation, verification, and repair are arbitrary typed nodes rather than a fixed phase list. Each run owns an immutable workflow snapshot, node guidance, payload contracts, attempt envelopes, trace order, and evidence references. Existing v1 run requests remain linear when resumed.

The operator is a loopback-only, bearer-authenticated local console. It is used to inspect runs, resolve checkpoints, stop or resume owned work, and author future workflow revisions. Active runs cannot be edited. Workflow activation is an attributed human decision that affects future runs only.

The improvement campaign is evaluator-owned. It compares bounded workflow policy and topology candidates against frozen development and held-out matrices, records append-only lineage, and emits a recommendation. It never activates a candidate.

Primary users are maintainers who need inspectable repository automation, explicit ownership, conservative mutation, reproducible evidence, and human control over publication and policy changes.

Product boundaries:

- Runtime code, judges, fixtures, safety invariants, provider selection, model selection, tools, commands, and promotion rules are not candidate-editable.
- Context graph memory is separately opt-in with `--graph-memory` and cannot authorize mutation.
- The supported execution sandbox is the repository's documented macOS evaluator backend. Unsupported hosts fail closed where that boundary applies.
- Local evidence is not publication or release evidence.
