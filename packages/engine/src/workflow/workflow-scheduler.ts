/** Deterministically schedules graph workflow nodes with reader and writer isolation. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, validateWorkflow, workflowDigest } from "./workflow-contract.js";
import { assembleBoundedWorkflowContext } from "./workflow-context-bounded.js";
import { scheduleWorkflowV21 } from "./workflow-scheduler-v21.js";
import { scheduleWorkflowV22 } from "./workflow-scheduler-v22.js";
import type {
  JsonValue,
  WorkflowsNodeEnvelopeV2,
  WorkflowsNodeEnvelopeV21,
  WorkflowsNodeEnvelopeV22,
  WorkflowsWorkflowV2,
  WorkflowsWorkflowV2DefsEdge,
  WorkflowsWorkflowV2DefsNode,
} from "@rae/contracts";
import type { WorkflowContract } from "./workflow-contract.js";

type WorkflowV2Node = WorkflowsWorkflowV2DefsNode;
type WorkflowV2Edge = WorkflowsWorkflowV2DefsEdge;
interface WorkflowInput {
  edge: WorkflowV2Edge;
  envelope: WorkflowsNodeEnvelopeV2;
}

interface SchedulerExecutionResult extends Record<string, unknown> {
  payload?: JsonValue;
  status?: WorkflowsNodeEnvelopeV2["status"];
  findings?: Array<Record<string, unknown>>;
  evidence_refs?: string[];
  ownership?: Record<string, unknown>;
  changed_paths?: string[];
  command_evidence?: Array<Record<string, unknown>>;
  resource_usage?: Record<string, unknown>;
}

interface SchedulerInvocation {
  node: WorkflowV2Node;
  inputs: WorkflowInput[];
  attempt: number;
  loop_iteration: number;
  sessionId: string;
  workflowDigest: string;
  context: unknown;
}

interface SettledNode {
  node: WorkflowV2Node;
  envelope: Readonly<WorkflowsNodeEnvelopeV2>;
}

type VersionedScheduler = (options: Record<string, unknown>) => Promise<unknown>;
type BoundedContextAssembler = (options: Record<string, unknown>) => {
  evidence: Record<string, unknown>;
};

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

export interface ScheduleWorkflowOptions {
  workflow: WorkflowContract;
  runId: string;
  execute: (invocation: SchedulerInvocation) => Promise<SchedulerExecutionResult>;
  runDir?: string | null;
  maxConcurrency?: number;
  maxRepairRounds?: number;
  stopRequested?: () => boolean;
  through?: string | null;
  resumeEnvelopes?: Array<
    WorkflowsNodeEnvelopeV2 | WorkflowsNodeEnvelopeV21 | WorkflowsNodeEnvelopeV22
  >;
  onEvent?: (event: Record<string, unknown>) => void;
  resolveTier?: unknown;
  task?: string;
  verifiedGraphRecords?: unknown;
  admittedMemory?: unknown;
  contextPolicy?: unknown;
  contextMode?: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function freezeEnvelope(
  value: Partial<WorkflowsNodeEnvelopeV2>,
): Readonly<WorkflowsNodeEnvelopeV2> {
  return Object.freeze({
    schema_version: "2.0.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    ...value,
  } as WorkflowsNodeEnvelopeV2);
}

function findingBlocks(finding: Record<string, unknown>): boolean {
  return finding.blocking === true || finding.severity === "blocking";
}

function conditionMatches(edge: WorkflowV2Edge, envelope: WorkflowsNodeEnvelopeV2): boolean {
  if (!edge.condition) return true;
  if (edge.condition === "success") return envelope.status === "passed";
  if (edge.condition === "failure") return ["failed", "blocked"].includes(envelope.status);
  if (edge.condition === "budget-available") {
    return payloadField(envelope.payload, "budget_available") !== false;
  }
  if (edge.condition === "blocking-findings") {
    return (
      ["failed", "blocked"].includes(String(payloadField(envelope.payload, "status"))) ||
      envelope.findings.some(findingBlocks)
    );
  }
  return false;
}

function predecessors(workflow: WorkflowsWorkflowV2, nodeId: string): WorkflowV2Edge[] {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

function inputsFor(
  workflow: WorkflowsWorkflowV2,
  nodeId: string,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
): WorkflowInput[] {
  return predecessors(workflow, nodeId)
    .filter((edge) => {
      const envelope = completed.get(edge.from);
      return envelope ? conditionMatches(edge, envelope) : false;
    })
    .sort((left, right) => left.from.localeCompare(right.from))
    .map((edge) => ({ edge, envelope: completed.get(edge.from) as WorkflowsNodeEnvelopeV2 }));
}

function shouldDisableNode(
  workflow: WorkflowsWorkflowV2,
  node: WorkflowV2Node,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
  disabled: Set<string>,
): boolean {
  if (completed.has(node.id) || running.has(node.id) || disabled.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (incoming.length === 0) return false;
  if (!incoming.every((edge) => completed.has(edge.from) || disabled.has(edge.from))) return false;
  return !incoming.some((edge) => {
    const envelope = completed.get(edge.from);
    return envelope ? conditionMatches(edge, envelope) : false;
  });
}

function disabledNodes(
  workflow: WorkflowsWorkflowV2,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
): Set<string> {
  const disabled = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (!shouldDisableNode(workflow, node, completed, running, disabled)) continue;
      disabled.add(node.id);
      changed = true;
    }
  }
  return disabled;
}

function nodeReady(
  workflow: WorkflowsWorkflowV2,
  node: WorkflowV2Node,
  completed: Map<string, Readonly<WorkflowsNodeEnvelopeV2>>,
  running: Map<string, Promise<SettledNode>>,
  disabled: Set<string>,
): boolean {
  if (completed.has(node.id) || running.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (node.id === workflow.entry_node) return true;
  if (incoming.some((edge) => !completed.has(edge.from) && !disabled.has(edge.from))) return false;
  const active = incoming.filter((edge) => {
    const envelope = completed.get(edge.from);
    return envelope ? conditionMatches(edge, envelope) : false;
  });
  const enabledIncoming = incoming.filter((edge) => !disabled.has(edge.from));
  return (
    active.length > 0 &&
    (node.kind !== "join" || node.join !== "all" || active.length === enabledIncoming.length)
  );
}

function persistEnvelope(runDir: string | null, envelope: WorkflowsNodeEnvelopeV2): void {
  if (!runDir) return;
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(directory, `${envelope.loop_iteration ?? 1}.${envelope.attempt}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

function loopForVerification(
  workflow: WorkflowsWorkflowV2,
  nodeId: string,
): WorkflowV2Node | undefined {
  return workflow.nodes.find(
    (node) => node.kind === "loop" && node.loop?.members?.includes(nodeId),
  );
}

function noProgressDigest(envelope: WorkflowsNodeEnvelopeV2): string {
  return digest({
    findings: envelope.findings,
    changed_paths: envelope.changed_paths,
    output: envelope.output_digest,
  });
}

function resultValue<T>(result: SchedulerExecutionResult, key: string, fallback: T): T {
  return (result[key] as T | undefined) ?? fallback;
}

function completedEnvelope({
  result,
  runId,
  workflowHash,
  node,
  attempt,
  loopIteration,
  inputDigest,
}: {
  result: SchedulerExecutionResult;
  runId: string;
  workflowHash: string;
  node: WorkflowV2Node;
  attempt: number;
  loopIteration: number;
  inputDigest: string;
}): Readonly<WorkflowsNodeEnvelopeV2> {
  const payload = resultValue<JsonValue>(result, "payload", result as unknown as JsonValue);
  const payloadFindings = payloadField(payload, "findings");
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    attempt,
    loop_iteration: loopIteration,
    status: resultValue(result, "status", "passed"),
    payload,
    findings: resultValue(
      result,
      "findings",
      (Array.isArray(payloadFindings) ? payloadFindings : []) as Array<Record<string, unknown>>,
    ),
    evidence_refs: resultValue(result, "evidence_refs", []),
    ownership: resultValue(result, "ownership", {}),
    changed_paths: resultValue(result, "changed_paths", []),
    command_evidence: resultValue(result, "command_evidence", []),
    resource_usage: resultValue(result, "resource_usage", {}),
    input_digest: inputDigest,
    output_digest: digest(payload),
  });
}

function loopExhaustionReason({
  round,
  repairLimit,
  repeats,
  budgetAvailable,
}: {
  round: number;
  repairLimit: number;
  repeats: number;
  budgetAvailable: unknown;
}): "no-progress" | "budget-exhausted" | "rounds-exhausted" | null {
  if (repeats >= 2) return "no-progress";
  if (budgetAvailable === false) return "budget-exhausted";
  if (round >= repairLimit) return "rounds-exhausted";
  return null;
}

/**
 * Executes ready nodes. Every invocation receives a fresh session id. The
 * callback owns provider mechanics; the scheduler owns ordering and envelopes.
 */
export async function scheduleWorkflow({
  workflow: suppliedWorkflow,
  runId,
  execute,
  runDir = null,
  maxConcurrency,
  maxRepairRounds,
  stopRequested = () => false,
  through = null,
  resumeEnvelopes = [],
  onEvent = () => {},
  resolveTier,
  task,
  verifiedGraphRecords,
  admittedMemory,
  contextPolicy,
  contextMode = "legacy",
}: ScheduleWorkflowOptions): Promise<unknown> {
  if (suppliedWorkflow?.schema_version === "2.2.0") {
    return (scheduleWorkflowV22 as unknown as VersionedScheduler)({
      workflow: suppliedWorkflow,
      runId,
      execute,
      runDir,
      through,
      resumeEnvelopes,
      onEvent,
      resolveTier,
      task,
      verifiedGraphRecords,
      admittedMemory,
      contextPolicy,
    });
  }
  if (suppliedWorkflow?.schema_version === "2.1.0") {
    return (scheduleWorkflowV21 as unknown as VersionedScheduler)({
      workflow: suppliedWorkflow,
      runId,
      execute,
      runDir,
      maxConcurrency,
      stopRequested,
      through,
      resumeEnvelopes,
      onEvent,
      resolveTier,
      task,
      contextMode,
    });
  }
  const workflow = validateWorkflow(suppliedWorkflow) as WorkflowsWorkflowV2;
  const workflowHash = workflowDigest(workflow);
  const concurrency = Math.min(maxConcurrency ?? workflow.budgets?.max_concurrency ?? 4, 4);
  const repairLimit = Math.min(maxRepairRounds ?? workflow.budgets?.max_repair_rounds ?? 5, 5);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be from 1 to 4");
  if (!Number.isInteger(repairLimit) || repairLimit < 0)
    throw new Error("max repair rounds must be from 0 to 5");

  const nodes = new Map<string, WorkflowV2Node>(workflow.nodes.map((node) => [node.id, node]));
  const v2ResumeEnvelopes = resumeEnvelopes as WorkflowsNodeEnvelopeV2[];
  const completed = new Map<string, Readonly<WorkflowsNodeEnvelopeV2>>(
    v2ResumeEnvelopes.map((envelope) => [envelope.node_id, Object.freeze(envelope)]),
  );
  const running = new Map<string, Promise<SettledNode>>();
  const attempts = new Map<string, number>();
  const busyResources = new Set<string>();
  const loopRounds = new Map<string, number>();
  const loopProgress = new Map<string, string[]>();
  for (const loop of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    const latestIteration = Math.max(
      1,
      ...v2ResumeEnvelopes
        .filter((envelope) => loop.loop?.members.includes(envelope.node_id) === true)
        .map((envelope) => envelope.loop_iteration ?? 1),
    );
    loopRounds.set(loop.id, latestIteration - 1);
  }
  let sequence = 0;

  const emit = (event: string, metadata: Record<string, unknown> = {}): void =>
    onEvent({ seq: ++sequence, event, ...metadata });

  async function invoke(node: WorkflowV2Node): Promise<Readonly<WorkflowsNodeEnvelopeV2>> {
    const attempt = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    const inputs = inputsFor(workflow, node.id, completed);
    const inputDigest = digest(inputs.map(({ envelope }) => envelope.output_digest));
    const sessionId = randomUUID();
    const loop = loopForVerification(workflow, node.id);
    const loopIteration = loop ? (loopRounds.get(loop.id) ?? 0) + 1 : 1;
    const context =
      contextMode === "bounded" && ["agent", "map"].includes(node.kind)
        ? (assembleBoundedWorkflowContext as unknown as BoundedContextAssembler)({
            task,
            node,
            inputs,
            runDir,
          })
        : null;
    if (context) emit("context_assembled", { node_id: node.id, ...context.evidence });
    emit("node_started", { node_id: node.id, attempt, session_id: sessionId });
    try {
      const result = await execute({
        node,
        inputs,
        attempt,
        loop_iteration: loopIteration,
        sessionId,
        workflowDigest: workflowHash,
        context,
      });
      const envelope = completedEnvelope({
        result,
        runId,
        workflowHash,
        node,
        attempt,
        loopIteration,
        inputDigest,
      });
      persistEnvelope(runDir, envelope);
      emit("node_completed", { node_id: node.id, attempt, status: envelope.status });
      return envelope;
    } catch (error) {
      emit("node_attempt_failed", {
        node_id: node.id,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      if (attempt < attemptsLimit && !stopRequested()) return invoke(node);
      throw error;
    }
  }

  function launch(node: WorkflowV2Node): void {
    if (node.resource) busyResources.add(node.resource);
    const promise = invoke(node)
      .then((envelope) => ({ node, envelope }))
      .finally(() => {
        if (node.resource) busyResources.delete(node.resource);
      });
    running.set(node.id, promise);
  }

  function readyNodes(): WorkflowV2Node[] {
    const disabled = disabledNodes(workflow, completed, running);
    return workflow.nodes
      .filter((node) => nodeReady(workflow, node, completed, running, disabled))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function maybeRepeatLoop(
    node: WorkflowV2Node,
    envelope: WorkflowsNodeEnvelopeV2,
  ): "none" | "repeat" | "no-progress" | "budget-exhausted" | "rounds-exhausted" {
    if (node.kind !== "gate" || envelope.status === "passed") return "none";
    const loop = loopForVerification(workflow, node.id);
    if (!loop) return "none";
    const round = (loopRounds.get(loop.id) ?? 0) + 1;
    const progress = noProgressDigest(envelope);
    const prior = loopProgress.get(loop.id) ?? [];
    const repeats = prior.filter((entry) => entry === progress).length + 1;
    loopProgress.set(loop.id, [...prior, progress]);
    const exhaustion = loopExhaustionReason({
      round,
      repairLimit,
      repeats,
      budgetAvailable: payloadField(envelope.payload, "budget_available"),
    });
    if (exhaustion) return exhaustion;
    loopRounds.set(loop.id, round);
    for (const member of loop.loop?.members ?? []) {
      completed.delete(member);
      attempts.delete(member);
    }
    emit("loop_restarted", { loop_id: loop.id, iteration: round + 1 });
    return "repeat";
  }

  for (const [nodeId, envelope] of [...completed]) {
    const node = nodes.get(nodeId);
    if (node?.kind !== "gate" || envelope.status === "passed") continue;
    const resumedLoopState = maybeRepeatLoop(node, envelope);
    if (!["none", "repeat"].includes(resumedLoopState)) {
      return {
        status: "repair-exhausted",
        reason: resumedLoopState,
        completed,
        workflow_digest: workflowHash,
        loop_rounds: loopRounds,
      };
    }
  }

  while (!completed.has(workflow.terminal_node)) {
    if (stopRequested()) {
      emit("workflow_stopped");
      return {
        status: "stopped",
        completed,
        workflow_digest: workflowHash,
        loop_rounds: loopRounds,
      };
    }
    const ready = readyNodes();
    const writer = ready.find(({ access }) => access === "write");
    if (writer && running.size === 0) {
      launch(writer);
    } else if (!writer && ![...running.keys()].some((id) => nodes.get(id)?.access === "write")) {
      for (const node of ready) {
        if (running.size >= concurrency) break;
        if (node.access === "write") continue;
        if (node.resource && busyResources.has(node.resource)) continue;
        launch(node);
      }
    }
    if (running.size === 0) {
      throw new Error(
        `workflow cannot make progress; completed: ${[...completed.keys()].sort().join(", ")}`,
      );
    }
    const settled = await Promise.race(running.values());
    running.delete(settled.node.id);
    completed.set(settled.node.id, settled.envelope);
    if (through === settled.node.id) {
      emit("workflow_through_reached", { node_id: through });
      return {
        status: "through",
        completed,
        workflow_digest: workflowHash,
        loop_rounds: loopRounds,
      };
    }
    const loopState = maybeRepeatLoop(settled.node, settled.envelope);
    if (!["none", "repeat"].includes(loopState)) {
      emit("loop_exhausted", { node_id: settled.node.id, reason: loopState });
      return {
        status: "repair-exhausted",
        reason: loopState,
        completed,
        workflow_digest: workflowHash,
        loop_rounds: loopRounds,
      };
    }
  }
  emit("workflow_completed", { node_id: workflow.terminal_node });
  return { status: "completed", completed, workflow_digest: workflowHash, loop_rounds: loopRounds };
}
