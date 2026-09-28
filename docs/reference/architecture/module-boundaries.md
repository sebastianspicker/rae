---
status: stable
owner: core
last_reviewed: 2026-09-28
source_of_truth: packages/engine/src/public/index.ts
evidence_links: ../claims/assumptions-register.md
---

# Module Boundaries

These are the import and ownership rules of the source layout. For
the complete component and runtime model, see the
[architecture guide](../../ARCHITECTURE.md).

## Dependency direction

```text
scripts/src/rae.ts
  -> applications -> @rae/engine public API
  -> engine cli -> run/workflow -> agents -> graph -> primitives
  -> Ralph

workflows -> engine
engine -> versioned contracts
runtime tools -> versioned contracts
profiles and maintenance tools remain independent
```

Inside the engine, `primitives/` imports no other engine layer, `graph/` uses
only primitives, `agents/` uses graph and primitives, `run/` and `workflow/`
form one layer that may import each other and everything below, and `cli/`
may import everything except `public/`. Shared engine helpers belong in the
lowest layer that needs them; for example path containment lives in
`primitives/paths.ts` and compiled entrypoint paths in
`primitives/installation-paths.ts`.

Applications must not import engine implementation files. The engine must not
depend on applications, Ralph, developer-tool source paths, profiles, or
maintenance tools. Executable runtime tools are explicit package dependencies.
Ralph is deliberately independent because its transaction model and persisted
state are distinct from workflow runs.

## Public and private surfaces

`packages/engine/src/public/index.ts` is the sole JavaScript package boundary.
Everything else below `packages/engine/src/` is private and may be reorganized.
Versioned schemas are public data contracts. Repository workflow files are
operator-editable configuration, while provider adapters and schedulers are
engine implementation.

Generated integration content under
`integrations/agent-adapters/content/<runner>/` must be changed through its
templates or manifest. Runtime state and generated build output are never
source dependencies.

Package exports and npm workspaces reinforce these boundaries.
