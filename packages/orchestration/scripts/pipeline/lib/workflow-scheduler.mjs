/** Deterministically schedules graph workflow nodes with reader and writer isolation. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, validateWorkflow, workflowDigest } from "./workflow-contract.mjs";
import { scheduleWorkflowV21 } from "./workflow-scheduler-v21.mjs";

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function freezeEnvelope(value) {
  return Object.freeze({
    schema_version: "2.0.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    ...value,
  });
}

function conditionMatches(edge, envelope) {
  if (!edge.condition) return true;
  if (edge.condition === "success") return envelope.status === "passed";
  if (edge.condition === "failure") return ["failed", "blocked"].includes(envelope.status);
  if (edge.condition === "budget-available") return envelope.payload?.budget_available !== false;
  if (edge.condition === "blocking-findings") {
    return (
      ["failed", "blocked"].includes(envelope.payload?.status) ||
      envelope.findings.some(
        (finding) => finding.blocking === true || finding.severity === "blocking",
      )
    );
  }
  return false;
}

function predecessors(workflow, nodeId) {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

function inputsFor(workflow, nodeId, completed) {
  return predecessors(workflow, nodeId)
    .filter((edge) => completed.has(edge.from) && conditionMatches(edge, completed.get(edge.from)))
    .sort((left, right) => left.from.localeCompare(right.from))
    .map((edge) => ({ edge, envelope: completed.get(edge.from) }));
}

function shouldDisableNode(workflow, node, completed, running, disabled) {
  if (completed.has(node.id) || running.has(node.id) || disabled.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (incoming.length === 0) return false;
  if (!incoming.every((edge) => completed.has(edge.from) || disabled.has(edge.from))) return false;
  return !incoming.some(
    (edge) => completed.has(edge.from) && conditionMatches(edge, completed.get(edge.from)),
  );
}

function disabledNodes(workflow, completed, running) {
  const disabled = new Set();
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

function nodeReady(workflow, node, completed, running, disabled) {
  if (completed.has(node.id) || running.has(node.id)) return false;
  const incoming = predecessors(workflow, node.id);
  if (node.id === workflow.entry_node) return true;
  if (incoming.some((edge) => !completed.has(edge.from) && !disabled.has(edge.from))) return false;
  const active = incoming.filter(
    (edge) => completed.has(edge.from) && conditionMatches(edge, completed.get(edge.from)),
  );
  const enabledIncoming = incoming.filter((edge) => !disabled.has(edge.from));
  return (
    active.length > 0 &&
    (node.kind !== "join" || node.join !== "all" || active.length === enabledIncoming.length)
  );
}

function persistEnvelope(runDir, envelope) {
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

function loopForVerification(workflow, nodeId) {
  return workflow.nodes.find(
    (node) => node.kind === "loop" && node.loop?.members?.includes(nodeId),
  );
}

function noProgressDigest(envelope) {
  return digest({
    findings: envelope.findings,
    changed_paths: envelope.changed_paths,
    output: envelope.output_digest,
  });
}

function resultValue(result, key, fallback) {
  return result?.[key] ?? fallback;
}

function completedEnvelope({
  result,
  runId,
  workflowHash,
  node,
  attempt,
  loopIteration,
  inputDigest,
}) {
  const payload = resultValue(result, "payload", result ?? {});
  return freezeEnvelope({
    run_id: runId,
    workflow_digest: workflowHash,
    node_id: node.id,
    attempt,
    loop_iteration: loopIteration,
    status: resultValue(result, "status", "passed"),
    payload,
    findings: resultValue(result, "findings", resultValue(payload, "findings", [])),
    evidence_refs: resultValue(result, "evidence_refs", []),
    ownership: resultValue(result, "ownership", {}),
    changed_paths: resultValue(result, "changed_paths", []),
    command_evidence: resultValue(result, "command_evidence", []),
    resource_usage: resultValue(result, "resource_usage", {}),
    input_digest: inputDigest,
    output_digest: digest(payload),
  });
}

function loopExhaustionReason({ round, repairLimit, repeats, budgetAvailable }) {
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
}) {
  if (suppliedWorkflow?.schema_version === "2.1.0") {
    return scheduleWorkflowV21({
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
    });
  }
  const workflow = validateWorkflow(suppliedWorkflow);
  const workflowHash = workflowDigest(workflow);
  const concurrency = Math.min(maxConcurrency ?? workflow.budgets?.max_concurrency ?? 4, 4);
  const repairLimit = Math.min(maxRepairRounds ?? workflow.budgets?.max_repair_rounds ?? 5, 5);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be from 1 to 4");
  if (!Number.isInteger(repairLimit) || repairLimit < 0)
    throw new Error("max repair rounds must be from 0 to 5");

  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const completed = new Map(
    resumeEnvelopes.map((envelope) => [envelope.node_id, Object.freeze(envelope)]),
  );
  const running = new Map();
  const attempts = new Map();
  const busyResources = new Set();
  const loopRounds = new Map();
  const loopProgress = new Map();
  for (const loop of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    const latestIteration = Math.max(
      1,
      ...resumeEnvelopes
        .filter((envelope) => loop.loop.members.includes(envelope.node_id))
        .map((envelope) => envelope.loop_iteration ?? 1),
    );
    loopRounds.set(loop.id, latestIteration - 1);
  }
  let sequence = 0;

  const emit = (event, metadata = {}) => onEvent({ seq: ++sequence, event, ...metadata });

  async function invoke(node) {
    const attempt = (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    const inputs = inputsFor(workflow, node.id, completed);
    const inputDigest = digest(inputs.map(({ envelope }) => envelope.output_digest));
    const sessionId = randomUUID();
    const loop = loopForVerification(workflow, node.id);
    const loopIteration = loop ? (loopRounds.get(loop.id) ?? 0) + 1 : 1;
    emit("node_started", { node_id: node.id, attempt, session_id: sessionId });
    try {
      const result = await execute({
        node,
        inputs,
        attempt,
        loop_iteration: loopIteration,
        sessionId,
        workflowDigest: workflowHash,
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
      emit("node_attempt_failed", { node_id: node.id, attempt, message: error.message });
      if (attempt < attemptsLimit && !stopRequested()) return invoke(node);
      throw error;
    }
  }

  function launch(node) {
    if (node.resource) busyResources.add(node.resource);
    const promise = invoke(node)
      .then((envelope) => ({ node, envelope }))
      .finally(() => {
        if (node.resource) busyResources.delete(node.resource);
      });
    running.set(node.id, promise);
  }

  function readyNodes() {
    const disabled = disabledNodes(workflow, completed, running);
    return workflow.nodes
      .filter((node) => nodeReady(workflow, node, completed, running, disabled))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function maybeRepeatLoop(node, envelope) {
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
      budgetAvailable: envelope.payload?.budget_available,
    });
    if (exhaustion) return exhaustion;
    loopRounds.set(loop.id, round);
    for (const member of loop.loop.members) {
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
    } else if (!writer && ![...running.keys()].some((id) => nodes.get(id).access === "write")) {
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
