/** Declares the sanitized browser projections used by the operator console. */
export interface OperatorEvent {
  seq: number;
  ts?: string;
  phase?: string;
  event?: string;
  status?: string;
  artifact_ref?: string;
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  kind?: string;
  access?: string;
  tier?: string;
  guidance?: string;
  role?: string;
  payload_contract?: string;
  join?: string;
  quorum?: { threshold?: number };
  failure_handling?: { mode?: string };
  resource?: string;
  loop?: { mode?: string; max_iterations?: number; members?: string[] };
  map?: { max_items?: number };
  transform?: Record<string, unknown>;
  verification?: boolean;
  mutation_checkpoint?: boolean;
  ownership_plan?: boolean;
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  type: string;
  condition?: string;
  artifact?: string;
  [key: string]: unknown;
}
export interface WorkflowDefinition {
  schema_version?: string;
  workflow_id?: string;
  revision: number;
  title?: string;
  entry_node?: string;
  terminal_node?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  budgets?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface WorkflowRecord {
  workflow_id: string;
  workflow: WorkflowDefinition;
  latest_revision?: number;
  revisions?: Array<{ revision: number; digest?: string; workflow?: WorkflowDefinition }>;
  active?: { workflow_id?: string; revision?: number } | null;
  activation_history?: Array<string | { revision?: number; activated_at?: string }>;
  digest?: string;
  [key: string]: unknown;
}

export interface OperatorRun {
  id: string;
  project_id?: string;
  task?: string;
  branch?: string;
  status?: string;
  needs_human_decision?: boolean;
  current_phase?: string;
  started_at?: string | null;
  updated_at?: string | null;
  runtime_active?: boolean;
  guarded?: boolean;
  workspace_mode?: string;
  workspace_label?: string;
  phase_order?: string[];
  completed_gates?: string[];
  gates?: Array<{ phase?: string; gate_id?: string; status?: string; artifact_ref?: string }>;
  evidence?: { present?: number };
  resources?: {
    input?: number | null;
    output?: number | null;
    cost?: number | null;
    agent_calls?: number;
  };
  checkpoints?: Array<
    Record<string, unknown> & {
      status?: string;
      checkpoint_id?: string;
      phase?: string;
      purpose?: string;
      message?: string;
      requested_at?: string;
    }
  >;
  controls?: Record<string, boolean>;
  workflow?:
    | WorkflowRecord
    | { workflow_id?: string; digest?: string; instances?: unknown[] }
    | null;
  graph_health?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface OperatorState {
  token: string | null;
  projects: Array<{ id: string; label: string }>;
  projectId: string | null;
  runs: OperatorRun[];
  runsCursor: string | null;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runId: string | null;
  runDetail: OperatorRun | null;
  detailGeneration: number;
  detailLoading: boolean;
  detailError: string | null;
  events: OperatorEvent[];
  eventIds: Set<number>;
  eventAfter: number;
  eventFrame: number | null;
  eventError: string | null;
  runQuery: string;
  runFilter: string;
  confirmAction: string | null;
  actionPending: boolean;
  runsGeneration: number;
  streamAbort: AbortController | null;
  streamGeneration: number;
  workflows: WorkflowRecord[];
  workflowId: string | null;
  workflow: WorkflowRecord | null;
  workflowView: string;
  workflowProfiles: Array<{ id: string; readiness: string; models?: Record<string, string> }>;
  workflowNodeId: string | null;
  workflowEdgeKey: string | null;
}

export type OperatorElement = HTMLElement & {
  value: string;
  checked: boolean;
  disabled: boolean;
  open: boolean;
  selectedIndex: number;
  selectedOptions: HTMLCollectionOf<HTMLOptionElement>;
  showModal(): void;
  close(): void;
  reportValidity(): boolean;
  readOnly: boolean;
};
