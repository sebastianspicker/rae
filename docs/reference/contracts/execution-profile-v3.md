---
status: experimental
owner: orchestration
last_reviewed: 2026-08-04
source_of_truth: packages/orchestration/contracts/workflows/execution-profile-v3.schema.json
evidence_links: ../claims/claims-ledger.md
---

# Execution profile 3.0

Execution profile schema `3.0.0` maps logical workflow tiers to named provider
routes. Workflow 2.1 remains provider-neutral. Provider selection is local run
configuration and is not stored in the workflow revision.

Each route declares an `executor` and `model`. Codex routes declare
`reasoning_effort`; OpenCode routes may declare `variant`. The `tiers` object
maps `economy`, `standard`, and `judgment` to route IDs. `node_routes` may
override a route for a specific provider-backed workflow node.

```json
{
  "schema_version": "3.0.0",
  "profile_id": "local-mixed",
  "routes": {
    "routine": {
      "executor": "codex",
      "model": "gpt-5.6-terra",
      "reasoning_effort": "medium"
    },
    "review": {
      "executor": "opencode",
      "model": "openrouter/example-model",
      "variant": "high"
    }
  },
  "tiers": {
    "economy": "routine",
    "standard": "routine",
    "judgment": "review"
  },
  "node_routes": {
    "security-review": "review"
  }
}
```

Profiles cannot contain credentials, commands, executable paths, tool grants,
or remote configuration references. RAE snapshots the canonical profile
digest and the resolved route, model, executor version, and executable digest
for every provider-backed node. Resume fails when this provenance drifts.

OpenCode is explicit and is never selected by `--provider auto`. OpenCode write
routes require an isolated RAE worktree and the macOS `sandbox-exec` backend.
The launcher verifies OpenCode's merged configuration before execution and
admits only read, glob, grep, workspace edit when required, and RAE's opaque
verification broker. Shell, web, external-directory, subagent, skill, plugin,
question, and unapproved MCP access remain denied.

The first OpenCode release supports provider models configured in OpenCode,
including `opencode/...` and `openrouter/...`. RAE does not call OpenRouter
directly.

## Interpretation limits

- the workflow remains provider-neutral, but selected prompts and repository
  context still cross the configured provider boundary
- local doctor and containment checks do not prove provider-side storage,
  retention, availability, or model behavior
- the current OpenCode adapter is a macOS-only execution surface

## Source note

- [OpenCode CLI](../claims/bibliography.md#src-opencode-cli)
- [OpenCode configuration](../claims/bibliography.md#src-opencode-config)
- [OpenCode permissions](../claims/bibliography.md#src-opencode-permissions)
- [OpenCode tools](../claims/bibliography.md#src-opencode-tools)
- [OpenCode providers](../claims/bibliography.md#src-opencode-providers)
- [JSON Schema 2020-12](../claims/bibliography.md#src-json-schema-2020-12)
- [Apple App Sandbox file access](../claims/bibliography.md#src-apple-app-sandbox)
