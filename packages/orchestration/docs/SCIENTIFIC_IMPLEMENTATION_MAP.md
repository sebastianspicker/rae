# Rationale to implementation map

| Concept | Implementation |
| --- | --- |
| Ordered stages | `scripts/pipeline/lib/phases.mjs` |
| Typed artifacts | `contracts/*.schema.json` |
| Pass/fail gates | `skills/dev-tools/quality-gate/` |
| Review consolidation | `skills/dev-tools/multi-model-review/` |
| Trace and summary validation | `skills/dev-tools/trace-collector/` |
| Phase policy | `policies/*.json` and `scripts/pipeline/lib/policy.mjs` |
| Autonomous execution | `scripts/pipeline/autonomous.mjs` |
| Isolated worktrees | `scripts/pipeline-init.sh` and pipeline worktree commands |
| Operator controls | `operator/` |
| Adapter synchronization | `adapters/templates/`, `adapters/spec/adapter-manifest.json`, and `scripts/adapters/generate_adapters.py` |

Use the [package README](../README.md) for supported commands and limitations.
Use the root [system overview](../../../docs/reference/architecture/system-overview.md)
and [claims ledger](../../../docs/reference/claims/claims-ledger.md) for
cross-package context and evidence.
