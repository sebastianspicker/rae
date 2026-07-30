---
status: experimental
owner: orchestration
last_reviewed: 2026-07-30
source_of_truth: packages/orchestration/contracts/workflows/workflow-v2.1.schema.json
evidence_links: ../reference/claims/evidence-index.md
---

# Graph Engineering with Codex and RAE

This course has two layers. The topology layer explains what work can proceed
and what must wait. The contract layer names the workflow fields that make that
decision durable and reviewable.

RAE and Codex solve different coordination problems. Native Codex
[subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) are
collaborators inside one Codex task. A RAE agent node starts a fresh,
ephemeral [`codex exec`](https://learn.chatgpt.com/docs/non-interactive-mode)
session and persists its validated result as workflow evidence. RAE also uses
isolated Git [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
for writer runs. It does not preserve a shared model conversation between
nodes.

Every agent or mapped agent instance consumes model tokens. Scheduling, joins,
condition evaluation, and allowlisted transforms do not call a model. A wider
graph can therefore increase cost even when its critical path is shorter.

## 1. Data and control edges

![Artifact, stream, condition, and loop-back edge contracts](../assets/diagrams/graph-edge-classification.svg)

Topology layer: an artifact edge carries one completed envelope. A stream edge
opens the matching mapped successor as soon as one item succeeds. A condition
edge selects a route. A loop-back edge stays inside a bounded loop.

Contract layer: `edges[].type` is one of `sequence`, `artifact`, `stream`,
`condition`, or `loop-back`. Conditions are fixed vocabulary. Workflow JSON
cannot contain an expression evaluator.

## 2. Contract-bound nodes

An agent node has guidance and an optional payload contract. The runtime passes
only typed predecessor envelopes and the mapped item, when present. A node can
request a logical `economy`, `standard`, or `judgment` tier. It cannot name a
provider, model, tool, command, environment value, or reasoning effort.

The operator owns concrete model selection in an execution profile:

```json
{
  "schema_version": "1.0.0",
  "profile_id": "local-codex-routing",
  "tiers": {
    "economy": { "model": "operator-economy-model", "reasoning_effort": "low" },
    "standard": { "model": "operator-standard-model", "reasoning_effort": "medium" },
    "judgment": { "model": "operator-judgment-model", "reasoning_effort": "high" }
  }
}
```

Replace the three operator-owned model identifiers with models available in
your Codex installation. The profile is validated and snapshotted by digest.
`--execution-profile` cannot be combined with global `--model` or
`--reasoning-effort`, and resume uses the stored snapshot.

## 3. Diamonds and deterministic reduction

![Barrier diamond compared with an item streaming pipeline](../assets/diagrams/diamond-versus-pipeline.svg)

A diamond fans one artifact into independent lenses and reduces their outputs.
Use `all` when every lens is mandatory, first-success `any` when one sufficient
answer is enough, and `quorum` when a declared threshold is the evidence rule.
Already-started branches continue to settle after `any` chooses a winner, so
the evidence trace does not hide late failures.

Use a transform node for mechanical reduction. The allowlist is `select`,
`flatten`, `deduplicate`, `sort`, `limit`, `group`, and bounded `cartesian`.
Transforms operate on JSON values only.

## 4. Barriers and streaming pipelines

A normal artifact edge is a barrier at the logical-node boundary. A `stream`
edge lets one mapped successor start per successful predecessor instance. One
mapped stage can have only one stream predecessor. Map size is at most 32,
stream depth is at most four, concurrency is at most four, and a run is capped
at 128 dynamic instances or provider attempts.

Stable fan-out identity comes from an RFC 6901 pointer into each item. The
runtime records the stable key and item digest separately. Resume recreates
missing instances without repeating completed identities.

## 5. Conditional routing and diverse-lens quorum

![Conditional routes entering a diverse-lens quorum](../assets/diagrams/routing-and-quorum.svg)

Routing decides relevance. Quorum decides sufficiency. Keep those policies in
separate nodes so an omitted route cannot silently lower the verification
threshold. Grouped quorum can require representation from named lens groups in
addition to an overall threshold.

`collect` failure handling is valid only for read or control work that feeds an
explicit threshold join. Writers and unhandled failures remain fail-closed. A
quorum fails as soon as its remaining inputs cannot satisfy the threshold.

## 6. Retry and failure containment

Each provider attempt has a fresh session identifier and a typed envelope.
After retry exhaustion, the failed envelope remains in the trace. A workflow
does not convert an exception into success. Writer nodes remain globally
serialized in the isolated worktree, and a writer waits for active readers to
drain.

## 7. Bounded and until-dry cycles

![Until-dry convergence across all previously seen keys](../assets/diagrams/until-dry-convergence.svg)

A bounded loop stops after at most five rounds. An `until-dry` loop also stops
when a round yields no globally unseen stable key. The seen set includes every
previous decision, including rejected findings. This prevents a rejected item
from being rediscovered forever under a different round.

## 8. Proposal, validation, activation, execution, evidence

![Human-activated workflow lifecycle](../assets/diagrams/human-activated-workflow-lifecycle.svg)

Generate a draft:

```bash
./scripts/rae.sh graph workflow propose \
  --project-root /path/to/target-repository \
  --task "Design a bounded review topology for this repository" \
  --base-workflow graph-native-default \
  --actor "operator-name" \
  --rationale "Draft for topology review"
```

The proposal session is read-only and ephemeral. RAE permits one correction
attempt after local validation, then stores only a valid optimistic-lock draft.
The command does not activate or execute it.

Review and activate an exact revision:

```bash
./scripts/rae.sh graph workflow validate \
  --project-root /path/to/target-repository \
  --workflow graph-native-default --revision 2

./scripts/rae.sh graph workflow diff \
  --project-root /path/to/target-repository \
  --workflow graph-native-default --from 1 --to 2

./scripts/rae.sh graph workflow activate \
  --project-root /path/to/target-repository \
  --workflow graph-native-default --revision 2 \
  --digest <digest-returned-by-validation> \
  --actor "operator-name" \
  --rationale "Reviewed contracts, bounds, and writer path"
```

Activation affects future runs only. Existing runs keep their immutable 2.0 or
2.1 snapshot.

## Six topology recipes

The maintained recipe files are under
`packages/orchestration/workflows/recipes/`. Validate a recipe before using it,
then pass the same file to `agent run`.

### Route auditing

`route-audit.workflow.json` maps a bounded route inventory, applies specialist
checks, and joins all results before verification.

```bash
./scripts/rae.sh graph workflow validate --project-root "$PWD" \
  --workflow-file packages/orchestration/workflows/recipes/route-audit.workflow.json
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/route-audit.workflow.json" \
  --task "Audit declared routes against handlers, authorization, and tests"
```

### Cited research

`cited-research.workflow.json` separates claim collection, source checking, and
quorum synthesis. Citations remain payload data, not executable references.

```bash
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/cited-research.workflow.json" \
  --execution-profile /absolute/path/to/operator-profile.json \
  --task "Research the requested change and return source-backed constraints"
```

### Module migration

`module-migration.workflow.json` maps read-only module analysis, forms an
ownership plan, crosses a mutation checkpoint, and uses one serialized writer.

```bash
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/module-migration.workflow.json" \
  --checkpoint-policy before-mutation \
  --task "Migrate the selected modules while preserving their public contracts"
```

### Adversarial review

`adversarial-review.workflow.json` uses independent safety, contract, test, and
scope lenses with a three-of-four quorum.

```bash
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/adversarial-review.workflow.json" \
  --task "Review the proposed design for blocking risks"
```

### Scheduled ecosystem scanning

`ecosystem-scan.workflow.json` maps a bounded package inventory and performs a
deterministic deduplication before verification. Scheduling belongs to the
operator's local scheduler; RAE itself does not install a timer.

```bash
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/ecosystem-scan.workflow.json" \
  --task "Scan the declared ecosystem snapshot for actionable compatibility changes"
```

### Unknown-size discovery

`unknown-size-discovery.workflow.json` uses an until-dry loop with a 32-item
round bound and five-round ceiling.

```bash
./scripts/rae.sh agent run --project-root /path/to/target \
  --workflow "$PWD/packages/orchestration/workflows/recipes/unknown-size-discovery.workflow.json" \
  --task "Discover and inspect all previously unseen integration points"
```

## Evidence limits

The deterministic topology benchmark measures event order, fixture critical
path, and barrier idle time. It does not establish model quality or a universal
speed advantage. Provider results, hardware, repository shape, and task
difficulty remain outside that fixture's claim.

## Source note

- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../reference/claims/bibliography.md#src-openai-paperbench)
- [IEEE 1012](../reference/claims/bibliography.md#src-ieee-1012)
- [Model Cards](../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../reference/claims/bibliography.md#src-datasheets)
- [Amdahl 1967](../reference/claims/bibliography.md#src-amdahl-1967)
