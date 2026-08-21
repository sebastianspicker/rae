# Product register

RAE is a source-distributed toolkit for bounded repository change, repair, and
evaluation. Codex is the default autonomous executor. OpenCode is available
only through an explicit route and the documented macOS containment backend.
RAE operates on a committed Git repository in an isolated worktree by default
and does not commit, push, publish, deploy, or promote workflow revisions.

The graph-native runtime treats a versioned workflow as executable policy. Requirements, design criticism, planning, alignment, mutation, verification, and repair are arbitrary typed nodes rather than a fixed phase list. Each run owns an immutable workflow snapshot, node guidance, payload contracts, attempt envelopes, trace order, and evidence references. Existing v1 run requests remain linear when resumed.

The operator is a loopback-only, bearer-authenticated local console. It is used to inspect runs, resolve checkpoints, stop or resume owned work, and author future workflow revisions. Active runs cannot be edited. Workflow activation is an attributed human decision that affects future runs only.

The experimental hosted-platform source is a separate control-plane and worker
slice. It stores control-plane state in PostgreSQL, protects routes with OIDC,
uses fenced worker leases, and can verify S3-compatible artifacts. The local
operator can proxy allowlisted remote routes, but the platform is not wired to
the umbrella CLI and it has no production
deployment or external integration evidence. Workflow 2.2 is likewise an
experimental local wait-and-signal contract. Its bounded context assembly does
not support a context-efficiency claim until the required 25 percent comparison
is recorded.

Primary users are maintainers who need inspectable repository automation, explicit ownership, conservative mutation, reproducible evidence, and human control over publication and policy changes.

Product boundaries:

- Runtime code, safety invariants, provider selection, model selection, tools, commands, and promotion rules are not candidate-editable.
- Context graph memory is separately opt-in with `--graph-memory` and cannot authorize mutation.
- OpenCode writes require the macOS Seatbelt backend and an isolated worktree.
  Codex retains its documented workspace sandbox requirements. Unsupported
  hosts fail closed where the selected boundary applies.
- Local evidence is not publication or release evidence.
