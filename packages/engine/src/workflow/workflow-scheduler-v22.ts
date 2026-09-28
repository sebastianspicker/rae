/** Schedules the local v2.2 wait-and-signal workflow subset deterministically. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, validateWorkflow, workflowDigest } from "./workflow-contract.js";
import { assembleWorkflowContextV22 } from "./workflow-context-v22.js";
import { applyWorkflowV22Event, readWorkflowV22State } from "./workflow-v22-reducer.js";
import { validateNodeEnvelope } from "./workflow-envelope.js";
import type {
  JsonValue,
  WorkflowsNodeEnvelopeV22,
  WorkflowsWorkflowV22,
  WorkflowsWorkflowV22DefsEdge,
  WorkflowsWorkflowV22DefsNode,
} from "@rae/contracts";

type WorkflowNode = WorkflowsWorkflowV22DefsNode;
type WorkflowEdge = WorkflowsWorkflowV22DefsEdge;
interface WorkflowInput {
  edge: WorkflowEdge;
  envelope: WorkflowsNodeEnvelopeV22;
}
interface WorkflowContext extends Record<string, unknown> {
  manifest: WorkflowsNodeEnvelopeV22["context_manifest"];
}
interface ExecutionResult extends Record<string, unknown> {
  payload?: JsonValue;
  status?: WorkflowsNodeEnvelopeV22["status"];
  findings?: Array<Record<string, unknown>>;
  evidence_refs?: string[];
  ownership?: Record<string, unknown>;
  changed_paths?: string[];
  command_evidence?: Array<Record<string, unknown>>;
  resource_usage?: Record<string, unknown>;
  execution_tier?: WorkflowsNodeEnvelopeV22["execution_tier"];
}
interface ResolvedTier extends Record<string, unknown> {
  tier: WorkflowsNodeEnvelopeV22["execution_tier"];
}
interface WorkflowSignal {
  signal_id: string;
  signal: string;
  payload: JsonValue;
}
interface WorkflowWaitState {
  status: string;
  deadline_at: string;
  last_consumed_signal_id?: string | null;
}
interface WorkflowV22State {
  waits: Record<string, WorkflowWaitState>;
  signals: WorkflowSignal[];
}
type WaitOutcome =
  | { kind: "signal"; signal: WorkflowSignal; deadline_at: string }
  | { kind: "timeout" | "waiting"; deadline_at: string };
interface ScheduleV22Options {
  workflow: WorkflowsWorkflowV22;
  runId: string;
  execute: (context: Record<string, unknown>) => Promise<ExecutionResult>;
  runDir?: string | null;
  resumeEnvelopes?: WorkflowsNodeEnvelopeV22[];
  through?: string | null;
  onEvent?: (event: Record<string, unknown>) => void;
  now?: () => string;
  resolveTier?: (tier?: string, nodeId?: string) => ResolvedTier;
  task?: string;
  verifiedGraphRecords?: unknown[];
  admittedMemory?: unknown[];
  contextPolicy?: Record<string, unknown>;
}
type ContextAssembler = (options: Record<string, unknown>) => WorkflowContext;
type StateReader = (options: Record<string, unknown>) => WorkflowV22State;
type StateReducer = (options: Record<string, unknown>) => WorkflowV22State;

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const successful = (envelope: WorkflowsNodeEnvelopeV22): boolean => envelope.status === "passed";

function conditionMatches(edge: WorkflowEdge, envelope: WorkflowsNodeEnvelopeV22): boolean {
  if (!edge.condition || edge.condition === "success") return successful(envelope);
  if (edge.condition === "failure") return ["failed", "blocked"].includes(envelope.status);
  if (edge.condition === "budget-available") {
    return payloadField(envelope.payload, "budget_available") !== false;
  }
  if (edge.condition === "blocking-findings") {
    return (envelope.findings ?? []).some(
      (finding) => finding.blocking === true || finding.severity === "blocking",
    );
  }
  return false;
}

function inputsFor(
  workflow: WorkflowsWorkflowV22,
  nodeId: string,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV22>>,
): WorkflowInput[] {
  return workflow.edges
    .filter((edge) => edge.to === nodeId && completed.has(edge.from))
    .filter((edge) => {
      const envelope = completed.get(edge.from);
      return envelope ? conditionMatches(edge, envelope) : false;
    })
    .sort((left, right) => left.from.localeCompare(right.from))
    .map((edge) => ({ edge, envelope: completed.get(edge.from) as WorkflowsNodeEnvelopeV22 }));
}

function predecessors(workflow: WorkflowsWorkflowV22, nodeId: string): WorkflowEdge[] {
  return workflow.edges.filter((edge) => edge.to === nodeId);
}

function ready(
  workflow: WorkflowsWorkflowV22,
  node: WorkflowNode,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV22>>,
): boolean {
  if (completed.has(node.id)) return false;
  if (node.id === workflow.entry_node) return true;
  const incoming = predecessors(workflow, node.id);
  if (!incoming.length || !incoming.every((edge) => completed.has(edge.from))) return false;
  const active = inputsFor(workflow, node.id, completed);
  if (node.kind === "join" && node.join === "all") return active.length === incoming.length;
  return active.length > 0;
}

function persistEnvelope(runDir: string | null, envelope: WorkflowsNodeEnvelopeV22): void {
  validateNodeEnvelope(envelope);
  if (!runDir) return;
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const instance = envelope.instance_id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(
    resolve(directory, `${instance}.${envelope.attempt}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

function freezeEnvelope(
  value: Partial<WorkflowsNodeEnvelopeV22>,
): Readonly<WorkflowsNodeEnvelopeV22> {
  return Object.freeze({
    schema_version: "2.2.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    failure: null,
    execution_tier: "standard",
    ...value,
  } as WorkflowsNodeEnvelopeV22);
}

interface EnvelopeArguments {
  runId: string;
  workflowHash: string;
  node: WorkflowNode;
  inputs: WorkflowInput[];
  attempt: number;
  context: WorkflowContext;
}

function ordinaryEnvelope({
  runId,
  workflowHash,
  node,
  inputs,
  attempt,
  result,
  context,
}: EnvelopeArguments & { result: ExecutionResult }): Readonly<WorkflowsNodeEnvelopeV22> {
  const payload = result.payload ?? (result as unknown as JsonValue);
  const payloadFindings = payloadField(payload, "findings");
  const output = {
    payload,
    findings:
      result.findings ??
      ((Array.isArray(payloadFindings) ? payloadFindings : []) as Array<Record<string, unknown>>),
    evidence_refs: result.evidence_refs ?? [],
    ownership: result.ownership ?? {},
    changed_paths: result.changed_paths ?? [],
    command_evidence: result.command_evidence ?? [],
    resource_usage: result.resource_usage ?? {},
  };
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    instance_id: node.id,
    attempt,
    status: result.status ?? "passed",
    ...output,
    input_digest: digest(inputs.map(({ envelope }) => envelope.output_digest)),
    output_digest: digest(output),
    execution_tier: result.execution_tier ?? node.tier ?? "runtime",
    context_manifest: context.manifest,
  });
}

function failureEnvelope({
  runId,
  workflowHash,
  node,
  inputs,
  attempt,
  error,
  context,
}: EnvelopeArguments & { error: unknown }): Readonly<WorkflowsNodeEnvelopeV22> {
  const failure = {
    type: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
  const payload = { status: "failed", failure };
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    instance_id: node.id,
    attempt,
    status: "failed",
    failure,
    payload,
    input_digest: digest(inputs.map(({ envelope }) => envelope.output_digest)),
    output_digest: digest(payload),
    context_manifest: context.manifest,
  });
}

function waitEnvelope({
  runId,
  workflowHash,
  node,
  inputs,
  attempt,
  payload,
  status,
  failure,
  context,
}: EnvelopeArguments & {
  payload: JsonValue;
  status: WorkflowsNodeEnvelopeV22["status"];
  failure: Record<string, unknown> | null;
}): Readonly<WorkflowsNodeEnvelopeV22> {
  const output = {
    payload,
    failure,
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
  };
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    instance_id: node.id,
    attempt,
    status,
    ...output,
    input_digest: digest(inputs.map(({ envelope }) => envelope.output_digest)),
    output_digest: digest(output),
    context_manifest: context.manifest,
  });
}

function waitOutcome({
  runDir,
  runId,
  workflowHash,
  node,
  now,
}: {
  runDir: string;
  runId: string;
  workflowHash: string;
  node: WorkflowNode;
  now: string;
}): WaitOutcome {
  if (!node.wait) throw new Error(`wait ${node.id} is missing its validated wait configuration`);
  let state = (readWorkflowV22State as unknown as StateReader)({
    runDir,
    runId,
    workflowDigest: workflowHash,
  });
  let wait = state.waits[node.id];
  if (!wait) {
    const deadline = new Date(
      new Date(now).getTime() + node.wait.timeout_seconds * 1000,
    ).toISOString();
    state = (applyWorkflowV22Event as unknown as StateReducer)({
      runDir,
      runId,
      workflowDigest: workflowHash,
      event: {
        type: "wait-open",
        node_id: node.id,
        deadline_at: deadline,
        accepted_signals: node.wait.signals,
      },
    });
    wait = state.waits[node.id];
  }
  if (!wait) throw new Error(`wait ${node.id} state was not persisted`);
  if (wait.status === "signalled" && wait.last_consumed_signal_id) {
    const signal = state.signals.find((entry) => entry.signal_id === wait.last_consumed_signal_id);
    if (!signal) throw new Error(`wait ${node.id} references an unknown consumed signal`);
    return {
      kind: "signal",
      signal,
      deadline_at: wait.deadline_at,
    };
  }
  state = (applyWorkflowV22Event as unknown as StateReducer)({
    runDir,
    runId,
    workflowDigest: workflowHash,
    event: { type: "wait-consume-earliest", node_id: node.id },
  });
  wait = state.waits[node.id];
  if (!wait) throw new Error(`wait ${node.id} state disappeared after signal consumption`);
  if (wait.last_consumed_signal_id) {
    const signal = state.signals.find((entry) => entry.signal_id === wait.last_consumed_signal_id);
    if (!signal) throw new Error(`wait ${node.id} references an unknown consumed signal`);
    return {
      kind: "signal",
      signal,
      deadline_at: wait.deadline_at,
    };
  }
  if (new Date(now).getTime() >= new Date(wait.deadline_at).getTime()) {
    (applyWorkflowV22Event as unknown as StateReducer)({
      runDir,
      runId,
      workflowDigest: workflowHash,
      event: { type: "wait-timeout", node_id: node.id },
    });
    return { kind: "timeout", deadline_at: wait.deadline_at };
  }
  return { kind: "waiting", deadline_at: wait.deadline_at };
}

/** Executes only v2.2 workflows. Waits return a resumable waiting result, not a provider call. */
export async function scheduleWorkflowV22({
  workflow: suppliedWorkflow,
  runId,
  execute,
  runDir,
  resumeEnvelopes = [],
  through = null,
  onEvent = () => {},
  now = () => new Date().toISOString(),
  resolveTier = (tier) => ({
    tier: (tier ?? "standard") as WorkflowsNodeEnvelopeV22["execution_tier"],
  }),
  task = "",
  verifiedGraphRecords = [],
  admittedMemory = [],
  contextPolicy = {},
}: ScheduleV22Options): Promise<Record<string, unknown>> {
  const workflow = validateWorkflow(suppliedWorkflow) as WorkflowsWorkflowV22;
  if (workflow.schema_version !== "2.2.0") throw new Error("v2.2 scheduler requires schema 2.2.0");
  if (!runDir) throw new Error("v2.2 scheduler requires durable run directory");
  const durableRunDir = runDir;
  const workflowHash = workflowDigest(workflow);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  const completed = new Map<string, Readonly<WorkflowsNodeEnvelopeV22>>();
  const attempts = new Map<string, number>();
  for (const entry of resumeEnvelopes) {
    if (entry.status === "failed" && entry.attempt < attemptsLimit) {
      attempts.set(entry.node_id, entry.attempt);
    } else {
      completed.set(entry.node_id, Object.freeze(entry));
    }
  }
  let sequence = 0;
  const emit = (event: string, metadata: Record<string, unknown> = {}): void =>
    onEvent({ seq: ++sequence, event, ...metadata });
  const contextFor = (node: WorkflowNode, inputs: WorkflowInput[]): WorkflowContext =>
    (assembleWorkflowContextV22 as unknown as ContextAssembler)({
      task,
      node,
      item: null,
      inputs,
      verifiedGraphRecords,
      admittedMemory,
      contextPolicy,
      capBytes: workflow.budgets?.max_context_bytes,
    });

  async function executeOrdinary(
    node: WorkflowNode,
    inputs: WorkflowInput[],
    context: WorkflowContext,
  ): Promise<Readonly<WorkflowsNodeEnvelopeV22>> {
    let envelope: Readonly<WorkflowsNodeEnvelopeV22>;
    do {
      const attempt = (attempts.get(node.id) ?? 0) + 1;
      attempts.set(node.id, attempt);
      emit("node_instance_started", { node_id: node.id, instance_id: node.id, attempt });
      try {
        const execution = resolveTier(node.tier ?? "standard", node.id);
        const result = await execute({
          node,
          inputs,
          attempt,
          sessionId: randomUUID(),
          context,
          execution,
        });
        envelope = ordinaryEnvelope({
          runId,
          workflowHash,
          node,
          inputs,
          attempt,
          result: { ...result, execution_tier: execution.tier },
          context,
        });
      } catch (error) {
        envelope = failureEnvelope({ runId, workflowHash, node, inputs, attempt, error, context });
      }
      persistEnvelope(durableRunDir, envelope);
      emit("node_instance_completed", {
        node_id: node.id,
        instance_id: node.id,
        status: envelope.status,
        attempt,
      });
      if (envelope.status === "failed" && attempt < attemptsLimit) {
        emit("node_instance_retrying", { node_id: node.id, instance_id: node.id, attempt });
      }
    } while (envelope.status === "failed" && envelope.attempt < attemptsLimit);
    return envelope;
  }

  function executeWait(
    node: WorkflowNode,
    inputs: WorkflowInput[],
    context: WorkflowContext,
  ):
    | { waiting: { node_id: string; deadline_at: string }; envelope?: undefined }
    | { envelope: Readonly<WorkflowsNodeEnvelopeV22>; waiting?: undefined } {
    const attempt = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    emit("node_instance_started", { node_id: node.id, instance_id: node.id, attempt });
    const outcome = waitOutcome({
      runDir: durableRunDir,
      runId,
      workflowHash,
      node,
      now: now(),
    });
    if (outcome.kind === "waiting") {
      emit("wait_open", { node_id: node.id, deadline_at: outcome.deadline_at });
      return { waiting: { node_id: node.id, deadline_at: outcome.deadline_at } };
    }
    const envelope =
      outcome.kind === "signal"
        ? waitEnvelope({
            runId,
            workflowHash,
            node,
            inputs,
            attempt,
            context,
            status: "passed",
            failure: null,
            payload: {
              status: "passed",
              signal: outcome.signal.signal,
              signal_id: outcome.signal.signal_id,
              payload: outcome.signal.payload,
              deadline_at: outcome.deadline_at,
            },
          })
        : waitEnvelope({
            runId,
            workflowHash,
            node,
            inputs,
            attempt,
            context,
            status: "failed",
            failure: {
              type: "TimeoutError",
              message: `wait ${node.id} timed out at ${outcome.deadline_at}`,
            },
            payload: { status: "failed", timeout: true, deadline_at: outcome.deadline_at },
          });
    persistEnvelope(durableRunDir, envelope);
    emit("node_instance_completed", {
      node_id: node.id,
      instance_id: node.id,
      status: envelope.status,
      attempt,
    });
    return { envelope };
  }

  while (!completed.has(workflow.terminal_node)) {
    const readyNodes = workflow.nodes.filter((node) => ready(workflow, node, completed));
    if (!readyNodes.length) {
      throw new Error(
        `workflow cannot make progress; completed: ${[...completed.keys()].sort().join(", ")}`,
      );
    }
    const wait = readyNodes.find((node) => node.kind === "wait");
    const writer = readyNodes.find((node) => node.access === "write");
    const batch = wait ? [wait] : writer ? [writer] : readyNodes.slice(0, 4);
    const settled = await Promise.all(
      batch.map(async (node) => {
        const inputs = inputsFor(workflow, node.id, completed);
        const context = contextFor(node, inputs);
        return {
          node,
          result:
            node.kind === "wait"
              ? executeWait(node, inputs, context)
              : { envelope: await executeOrdinary(node, inputs, context) },
        };
      }),
    );
    for (const { node, result } of settled) {
      if (result.waiting) {
        return {
          status: "waiting",
          completed,
          workflow_digest: workflowHash,
          wait: result.waiting,
        };
      }
      completed.set(node.id, result.envelope);
      if (through === node.id)
        return { status: "through", completed, workflow_digest: workflowHash };
    }
  }
  emit("workflow_completed", { node_id: workflow.terminal_node });
  return { status: "completed", completed, workflow_digest: workflowHash };
}
