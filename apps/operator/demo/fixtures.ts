/** Deterministic, browser-only data for the static operator Pages demo. */
import type {
  OperatorEvent,
  OperatorRun,
  WorkflowDefinition,
  WorkflowRecord,
} from "../static/js/types.js";

const now = "2026-09-02T09:30:00.000Z";

const workflow = (revision = 3): WorkflowDefinition => ({
  schema_version: "2.1.0",
  workflow_id: "repository-change",
  revision,
  title: "Repository change with human release hold",
  entry_node: "inspect",
  terminal_node: "close",
  budgets: {
    max_concurrency: 4,
    max_map_items: 16,
    max_pipeline_depth: 3,
    max_dynamic_instances: 32,
    max_repair_rounds: 3,
  },
  nodes: [
    {
      id: "inspect",
      kind: "agent",
      access: "read",
      tier: "economy",
      guidance: "Inspect the bounded repository surface.",
    },
    {
      id: "plan",
      kind: "agent",
      access: "read",
      tier: "standard",
      guidance: "Draft a verifiable implementation plan.",
    },
    {
      id: "verify",
      kind: "gate",
      access: "read",
      tier: "judgment",
      verification: true,
      guidance: "Run deterministic verification.",
    },
    {
      id: "hold",
      kind: "checkpoint",
      access: "control",
      mutation_checkpoint: true,
      guidance: "Require an attributed human decision.",
    },
    { id: "close", kind: "terminal", access: "read", guidance: "Write bounded local evidence." },
  ],
  edges: [
    { from: "inspect", to: "plan", type: "sequence" },
    { from: "plan", to: "verify", type: "sequence" },
    { from: "verify", to: "hold", type: "sequence" },
    { from: "hold", to: "close", type: "condition", condition: "approved" },
  ],
});

const resources = (input: number, output: number, cost: number, agent_calls: number) => ({
  input,
  output,
  cost,
  agent_calls,
});
const baseRun = (overrides: Partial<OperatorRun>): OperatorRun => ({
  id: "run-demo",
  branch: "rae/demo-evidence",
  workspace_mode: "isolated",
  workspace_label: "Mock worktree",
  phase_order: ["inspect", "plan", "verify", "ship"],
  gates: [
    {
      phase: "inspect",
      gate_id: "inspect-gate",
      status: "pass",
      artifact_ref: "evidence/inspect.json",
    },
    { phase: "plan", gate_id: "plan-gate", status: "pass", artifact_ref: "evidence/plan.md" },
    {
      phase: "verify",
      gate_id: "verify-gate",
      status: "pending",
      artifact_ref: "evidence/checks.json",
    },
  ],
  completed_gates: ["inspect-gate", "plan-gate"],
  evidence: { present: 4 },
  workflow: { workflow_id: "repository-change", digest: "demo-validated-digest", instances: [] },
  checkpoints: [],
  needs_human_decision: false,
  controls: { stop: false, resume: false, interrupt: false, cleanup: false },
  started_at: now,
  updated_at: now,
  ...overrides,
});

export interface DemoFixtures {
  projects: Array<{ id: string; label: string }>;
  profiles: Array<{ id: string; readiness: string; models: Record<string, string> }>;
  runs: OperatorRun[];
  events: Record<string, OperatorEvent[]>;
  templates: Array<{ id: string; title: string }>;
  workflows: Map<string, WorkflowRecord>;
  proposal?: Record<string, unknown>;
}

export function createDemoFixtures(): DemoFixtures {
  const runs = [
    baseRun({
      id: "run-demo-active",
      task: "Add a bounded demonstration without repository access",
      status: "running",
      runtime_active: true,
      current_phase: "verify",
      resources: resources(12840, 4310, 0.42, 5),
      controls: { stop: true, resume: false, interrupt: true, cleanup: false },
    }),
    baseRun({
      id: "run-demo-hold",
      task: "Review an evidence-backed release decision",
      status: "waiting",
      needs_human_decision: true,
      runtime_active: false,
      current_phase: "ship",
      resources: resources(9670, 2870, 0.31, 4),
      checkpoints: [
        {
          checkpoint_id: "checkpoint-demo-ship",
          status: "pending",
          purpose: "ship",
          phase: "ship",
          message: "Approve the recorded verification evidence before local release preparation.",
          requested_at: now,
        },
      ],
      controls: { stop: true, resume: false, interrupt: false, cleanup: false },
    }),
    baseRun({
      id: "run-demo-complete",
      task: "Validate the local migration ledger",
      status: "completed",
      runtime_active: false,
      current_phase: "ship",
      completed_gates: ["inspect-gate", "plan-gate", "verify-gate"],
      gates: [
        {
          phase: "inspect",
          gate_id: "inspect-gate",
          status: "pass",
          artifact_ref: "evidence/inspect.json",
        },
        { phase: "plan", gate_id: "plan-gate", status: "pass", artifact_ref: "evidence/plan.md" },
        {
          phase: "verify",
          gate_id: "verify-gate",
          status: "pass",
          artifact_ref: "evidence/checks.json",
        },
      ],
      resources: resources(7180, 2110, 0.24, 3),
      controls: { stop: false, resume: false, interrupt: false, cleanup: true },
    }),
  ];
  const events: Record<string, OperatorEvent[]> = Object.fromEntries(
    runs.map((run) => [
      run.id,
      [
        {
          seq: 1,
          ts: now,
          phase: "inspect",
          event: "evidence projected",
          artifact_ref: "evidence/inspect.json",
          status: "pass",
          tier: "economy",
        },
        {
          seq: 2,
          ts: "2026-09-02T09:34:00.000Z",
          phase: "plan",
          event: "plan validated",
          gate_id: "plan-gate",
          status: "pass",
          tier: "standard",
        },
        {
          seq: 3,
          ts: "2026-09-02T09:37:00.000Z",
          phase: run.current_phase,
          event: run.status === "completed" ? "run completed" : "verification pending",
          status: run.status === "completed" ? "pass" : "pending",
          tier: "judgment",
        },
      ],
    ]),
  );
  const definition = workflow();
  return {
    projects: [{ id: "demo-project", label: "Mock repository · no filesystem access" }],
    profiles: [
      {
        id: "demo-standard",
        readiness: "mock loaded",
        models: { economy: "gpt-5-mini", standard: "gpt-5", judgment: "gpt-5" },
      },
      {
        id: "demo-review",
        readiness: "mock loaded",
        models: { economy: "gpt-5-mini", standard: "gpt-5", judgment: "gpt-5.6" },
      },
    ],
    runs,
    events,
    templates: [
      { id: "evidence-loop", title: "Evidence loop" },
      { id: "review-hold", title: "Review hold" },
    ],
    workflows: new Map([
      [
        definition.workflow_id ?? "repository-change",
        {
          workflow_id: definition.workflow_id ?? "repository-change",
          digest: "demo-validated-digest",
          active: { workflow_id: definition.workflow_id, revision: 3 },
          revisions: [{ revision: 3, workflow: definition, digest: "demo-validated-digest" }],
          workflow: definition,
          activation_history: [{ revision: 3, activated_at: now }],
        },
      ],
    ]),
  };
}

export function demoWorkflowTemplate(templateId: string, revision: number): WorkflowDefinition {
  const definition = workflow(revision);
  definition.title =
    templateId === "review-hold" ? "Review hold workflow" : "Evidence loop workflow";
  if (templateId === "evidence-loop" && definition.nodes[2])
    definition.nodes[2].loop = { mode: "bounded", max_iterations: 2, members: ["plan", "verify"] };
  return definition;
}
