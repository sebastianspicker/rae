---
status: stable
owner: core
last_reviewed: 2026-08-27
source_of_truth: README.md
evidence_links: claims/evidence-index.md
---

# Repository Map

| Path | Ownership |
| --- | --- |
| `apps/operator/` | Authenticated loopback operator interface |
| `apps/platform/` | Independently packaged experimental hosted adapter |
| `packages/engine/` | Workflow, run, provider, graph, and evidence runtime |
| `packages/contracts/` | Versioned cross-boundary schemas |
| `packages/ralph/` | Independent deterministic story loop |
| `packages/dev-tools/` | Isolated quality, review, and trace tools |
| `workflows/` | Repository-owned workflow definitions and recipes |
| `integrations/agent-adapters/` | Adapter templates, generated guidance, and sync tooling |
| `profiles/agent-environments/` | Sanitized portable environment publication lane |
| `tools/` | Narrow repository-maintenance utilities |
| `scripts/` | Umbrella CLI and repository-wide checks |
| `docs/` | Maintained tutorials, how-to guides, reference, and rationale |

The normal operator path begins at `npm run rae --`, which dispatches to the
engine, operator, Ralph, or a narrow tool. Engine runs record local artifacts
under `.pipeline/`; Ralph and supporting tools retain their own explicitly
documented state. Validators decide whether those artifacts support a claim.

Use package-local documentation for implementation detail and command truth.
Use umbrella documentation for execution-model selection, cross-package
contracts, claim quality, and release constraints.
