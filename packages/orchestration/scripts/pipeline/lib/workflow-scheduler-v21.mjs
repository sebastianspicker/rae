/** Schedules immutable v2.1 node instances with bounded fan-out, joins, and stream pipelines. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, validateWorkflow, workflowDigest } from "./workflow-contract.mjs";
import { deduplicateDiscovery, pointerValue } from "./workflow-transforms.mjs";
import { validateNodeEnvelope } from "./workflow-envelope.mjs";

const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const successful = (envelope) => envelope.status === "passed";

function conditionMatches(edge, envelope) {
  if (!edge.condition) return successful(envelope);
  if (edge.condition === "success") return successful(envelope);
  if (edge.condition === "failure")
    return ["failed", "blocked", "collected"].includes(envelope.status);
  if (edge.condition === "budget-available") return envelope.payload?.budget_available !== false;
  if (edge.condition === "blocking-findings")
    return envelope.findings.some(
      (finding) => finding.blocking === true || finding.severity === "blocking",
    );
  return false;
}

function predecessors(workflow, nodeId) {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

function persistEnvelope(runDir, envelope) {
  validateNodeEnvelope(envelope);
  if (!runDir) return;
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safeInstance = envelope.instance_id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(
    resolve(directory, `${safeInstance}.${envelope.attempt}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

function instanceId(nodeId, itemKey) {
  return itemKey === null ? nodeId : `${nodeId}:${digest(String(itemKey)).slice(0, 16)}`;
}

function freezeEnvelope(value) {
  return Object.freeze({
    schema_version: "2.1.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    parent_node: null,
    item_key: null,
    item_digest: null,
    failure: null,
    selection: null,
    quorum: null,
    convergence: null,
    execution_tier: "standard",
    ...value,
  });
}

function failureEnvelope(base, error) {
  const failure = { type: error?.name ?? "Error", message: error?.message ?? String(error) };
  const payload = { status: "failed", failure };
  return freezeEnvelope({
    ...base,
    status: "failed",
    failure,
    payload,
    findings: [],
    output_digest: digest(payload),
  });
}

function anyJoinDecision(passed, allSettled) {
  if (passed.length === 0)
    return allSettled
      ? { impossible: true, reason: "any join has no successful input" }
      : { ready: false };
  const winner = passed[0];
  return {
    ready: true,
    inputs: [winner],
    selection: { mode: "any", winner: winner.envelope.instance_id },
  };
}

/** Executes a validated v2.1 workflow without mutating its logical topology. */
export async function scheduleWorkflowV21({
  workflow: suppliedWorkflow,
  runId,
  execute,
  runDir = null,
  maxConcurrency,
  stopRequested = () => false,
  through = null,
  resumeEnvelopes = [],
  onEvent = () => {},
  resolveTier = (tier) => ({ tier: tier ?? "standard" }),
}) {
  const workflow = validateWorkflow(suppliedWorkflow);
  if (workflow.schema_version !== "2.1.0") throw new Error("v2.1 scheduler requires schema 2.1.0");
  const workflowHash = workflowDigest(workflow);
  const concurrency = Math.min(maxConcurrency ?? workflow.budgets?.max_concurrency ?? 4, 4);
  const attemptsLimit = Math.min(workflow.budgets?.max_attempts_per_node ?? 3, 3);
  const dynamicLimit = Math.min(workflow.budgets?.max_dynamic_instances ?? 128, 128);
  const mapLimit = Math.min(workflow.budgets?.max_map_items ?? 32, 32);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("max concurrency must be from 1 to 4");

  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const completed = new Map();
  const byNode = new Map(workflow.nodes.map((node) => [node.id, new Set()]));
  const pending = new Map();
  const running = new Map();
  const expanded = new Set();
  const busyResources = new Set();
  const attempts = new Map();
  const memberLoop = new Map();
  const loopIterations = new Map();
  const loopSeen = new Map();
  for (const loop of workflow.nodes.filter((node) => node.kind === "loop")) {
    loopIterations.set(loop.id, 1);
    loopSeen.set(loop.id, []);
    for (const member of loop.loop.members) memberLoop.set(member, loop);
  }
  let providerAttempts = 0;
  let sequence = 0;
  let fatal = null;
  const emit = (event, metadata = {}) => onEvent({ seq: ++sequence, event, ...metadata });

  function addCompleted(envelope) {
    if (envelope.workflow_digest !== workflowHash)
      throw new Error("resume envelope workflow digest mismatch");
    completed.set(envelope.instance_id ?? envelope.node_id, Object.freeze(envelope));
    byNode.get(envelope.node_id)?.add(envelope.instance_id ?? envelope.node_id);
  }
  for (const envelope of resumeEnvelopes) {
    const id = envelope.instance_id ?? envelope.node_id;
    if (envelope.status === "failed" && envelope.attempt < attemptsLimit) {
      attempts.set(id, envelope.attempt);
      continue;
    }
    addCompleted(envelope);
    if (envelope.status === "failed") {
      fatal = new Error(
        `workflow node instance ${id} exhausted retries: ${envelope.failure?.message ?? "failed"}`,
      );
    }
  }
  for (const node of workflow.nodes) {
    const instances = [...byNode.get(node.id)];
    if (node.kind !== "map" && instances.length) expanded.add(node.id);
  }

  const nodeEnvelopes = (nodeId) =>
    [...(byNode.get(nodeId) ?? [])].map((id) => completed.get(id)).filter(Boolean);
  const nodeRunning = (nodeId) =>
    [...running.values()].some((entry) => entry.spec.node.id === nodeId);
  const nodePending = (nodeId) => [...pending.values()].some((spec) => spec.node.id === nodeId);
  const isSettled = (nodeId) =>
    expanded.has(nodeId) && !nodeRunning(nodeId) && !nodePending(nodeId);

  function baseInputs(nodeId) {
    const loop = memberLoop.get(nodeId);
    const iteration = loop ? loopIterations.get(loop.id) : null;
    return predecessors(workflow, nodeId)
      .filter((edge) => edge.type !== "stream")
      .flatMap((edge) =>
        nodeEnvelopes(edge.from)
          .filter(
            (envelope) =>
              conditionMatches(edge, envelope) &&
              (!loop || !memberLoop.has(edge.from) || envelope.loop_iteration === iteration),
          )
          .map((envelope) => ({ edge, envelope })),
      )
      .sort((left, right) => left.envelope.instance_id.localeCompare(right.envelope.instance_id));
  }

  function predecessorsSettled(nodeId, { excludeStream = true } = {}) {
    const edges = predecessors(workflow, nodeId).filter(
      (edge) => !excludeStream || edge.type !== "stream",
    );
    return edges.every((edge) => isSettled(edge.from));
  }

  function queue(
    node,
    { item = null, itemKey = null, itemDigest = null, parentNode = null, inputs = null } = {},
  ) {
    const loop = memberLoop.get(node.id);
    const loopIteration = loop ? loopIterations.get(loop.id) : 1;
    const stableId = instanceId(node.id, itemKey);
    const id =
      loop && loopIteration > 1 && itemKey === null
        ? `${stableId}:loop-${loopIteration}`
        : stableId;
    if (completed.has(id) || pending.has(id) || running.has(id)) return;
    if (pending.size + running.size + completed.size >= dynamicLimit)
      throw new Error(`workflow exceeds ${dynamicLimit} dynamic instances`);
    pending.set(id, {
      node,
      instance_id: id,
      item,
      item_key: itemKey,
      item_digest: itemDigest,
      parent_node: parentNode,
      inputs,
      loop_iteration: loopIteration,
    });
    byNode.get(node.id).add(id);
  }

  function expandMap(node) {
    if (expanded.has(node.id)) return;
    const streamEdge = predecessors(workflow, node.id).find((edge) => edge.type === "stream");
    if (streamEdge) {
      for (const envelope of nodeEnvelopes(streamEdge.from).filter(successful)) {
        const key = envelope.item_key ?? envelope.instance_id;
        queue(node, {
          item: envelope.payload,
          itemKey: key,
          itemDigest: envelope.item_digest ?? digest(envelope.payload),
          parentNode: streamEdge.from,
          inputs: [{ edge: streamEdge, envelope }],
        });
      }
      if (isSettled(streamEdge.from)) expanded.add(node.id);
      return;
    }
    if (!predecessorsSettled(node.id)) return;
    const inputs = baseInputs(node.id);
    const sourceEnvelope = inputs[0]?.envelope;
    const items = pointerValue(sourceEnvelope?.payload, node.map.source_pointer);
    if (!Array.isArray(items))
      throw new Error(`map ${node.id} source pointer must resolve to an array`);
    const limit = Math.min(node.map.max_items ?? mapLimit, mapLimit, 32);
    if (items.length > limit) throw new Error(`map ${node.id} exceeds its ${limit}-item bound`);
    const identities = new Set();
    for (const item of items) {
      const keyValue = pointerValue(item, node.map.stable_key_pointer);
      if (!["string", "number", "boolean"].includes(typeof keyValue))
        throw new Error(`map ${node.id} stable key must be a scalar`);
      const key = String(keyValue);
      const itemHash = digest(item);
      const identity = instanceId(node.id, key);
      if (identities.has(identity))
        throw new Error(`map ${node.id} contains duplicate stable key ${key}`);
      identities.add(identity);
      queue(node, {
        item,
        itemKey: key,
        itemDigest: itemHash,
        parentNode: sourceEnvelope?.node_id ?? null,
        inputs,
      });
    }
    expanded.add(node.id);
    emit("map_expanded", { node_id: node.id, instances: items.length });
  }

  function joinDecision(node) {
    const edges = predecessors(workflow, node.id);
    const envelopes = edges.flatMap((edge) =>
      nodeEnvelopes(edge.from).map((envelope) => ({ edge, envelope })),
    );
    const passed = envelopes.filter(({ edge, envelope }) => conditionMatches(edge, envelope));
    const allSettled = edges.every((edge) => isSettled(edge.from));
    if (node.join === "all") return allSettled ? { ready: true, inputs: passed } : { ready: false };
    if (node.join === "any") return anyJoinDecision(passed, allSettled);
    const threshold = node.quorum.threshold;
    const groupState = (node.quorum.groups ?? []).map((group) => {
      const accepted = passed.filter(({ edge }) => group.members.includes(edge.from)).length;
      const remaining = group.members.filter((member) => !isSettled(member)).length;
      return { id: group.id, threshold: group.threshold, accepted, remaining };
    });
    const groupsPassed = groupState.every((group) => group.accepted >= group.threshold);
    const groupImpossible = groupState.some(
      (group) => group.accepted + group.remaining < group.threshold,
    );
    if (passed.length >= threshold && groupsPassed)
      return {
        ready: true,
        inputs: passed,
        quorum: {
          threshold,
          passed: passed.length,
          possible: envelopes.length,
          groups: groupState,
        },
      };
    const remaining = edges.filter((edge) => !isSettled(edge.from)).length;
    if (passed.length + remaining < threshold || groupImpossible || allSettled)
      return {
        impossible: true,
        reason: `quorum ${node.id} became impossible`,
        quorum: { threshold, passed: passed.length, remaining, groups: groupState },
      };
    return { ready: false };
  }

  function discover() {
    for (const node of workflow.nodes) {
      if (node.kind === "map") expandMap(node);
      if (node.kind === "map" || expanded.has(node.id)) continue;
      if (node.id === workflow.entry_node) {
        queue(node);
        expanded.add(node.id);
        continue;
      }
      if (node.kind === "join") {
        const decision = joinDecision(node);
        if (decision.impossible) {
          fatal = new Error(decision.reason);
          emit("quorum_impossible", { node_id: node.id, quorum: decision.quorum });
          continue;
        }
        if (decision.ready) {
          queue(node, { inputs: decision.inputs });
          expanded.add(node.id);
        }
        continue;
      }
      if (!predecessorsSettled(node.id)) continue;
      const inputs = baseInputs(node.id);
      if (predecessors(workflow, node.id).length && inputs.length === 0) {
        expanded.add(node.id);
        continue;
      }
      queue(node, { inputs });
      expanded.add(node.id);
    }
  }

  function streamSuccessors(spec, envelope) {
    for (const edge of workflow.edges.filter(
      (candidate) => candidate.from === spec.node.id && candidate.type === "stream",
    )) {
      const target = nodes.get(edge.to);
      if (!successful(envelope)) continue;
      const key = envelope.item_key ?? envelope.instance_id;
      const itemHash = envelope.item_digest ?? digest(envelope.payload);
      queue(target, {
        item: envelope.payload,
        itemKey: key,
        itemDigest: itemHash,
        parentNode: spec.node.id,
        inputs: [{ edge, envelope }],
      });
      emit("stream_instance_ready", {
        node_id: target.id,
        instance_id: instanceId(target.id, key),
        parent_node: spec.node.id,
      });
    }
  }

  function thresholdToleratesFailure(node) {
    if (node.access === "write") return false;
    return workflow.edges
      .filter((edge) => edge.from === node.id && edge.type !== "loop-back")
      .some((edge) => ["any", "quorum"].includes(nodes.get(edge.to)?.join));
  }

  function collectPolicyError(node) {
    if (node.failure_handling?.mode !== "collect") return null;
    const envelopes = nodeEnvelopes(node.id);
    const failures = envelopes.filter((envelope) => !successful(envelope)).length;
    if (failures > (node.failure_handling.max_failures ?? 0))
      return `collect node ${node.id} exceeded its failure bound`;
    if (
      isSettled(node.id) &&
      envelopes.filter(successful).length < (node.failure_handling.minimum_successes ?? 1)
    ) {
      return `collect node ${node.id} did not reach its minimum successes`;
    }
    return null;
  }

  function advanceUntilDry(spec, envelope) {
    const edge = workflow.edges.find(
      (candidate) => candidate.from === spec.node.id && candidate.type === "loop-back",
    );
    if (!edge) return false;
    const loop = memberLoop.get(spec.node.id);
    if (loop?.loop.mode !== "until-dry") return false;
    const convergence = deduplicateDiscovery(
      pointerValue(envelope.payload, loop.loop.source_pointer),
      loop.loop.stable_key_pointer,
      loopSeen.get(loop.id),
    );
    loopSeen.set(loop.id, convergence.seen_keys);
    emit("loop_convergence", {
      loop_id: loop.id,
      iteration: loopIterations.get(loop.id),
      fresh: convergence.fresh.length,
      rejected: convergence.rejected.length,
      dry: convergence.dry,
      seen: convergence.seen_keys.length,
    });
    if (convergence.dry) return false;
    const iteration = loopIterations.get(loop.id);
    if (iteration >= loop.loop.max_iterations) {
      fatal = new Error(`until-dry loop ${loop.id} reached its ${iteration}-round bound`);
      return true;
    }
    loopIterations.set(loop.id, iteration + 1);
    for (const member of loop.loop.members) expanded.delete(member);
    const target = nodes.get(edge.to);
    queue(target, {
      item: convergence.fresh,
      parentNode: spec.node.id,
      inputs: [{ edge, envelope }],
    });
    expanded.add(target.id);
    emit("loop_restarted", { loop_id: loop.id, iteration: iteration + 1 });
    return true;
  }

  async function invoke(spec) {
    const attempt = (attempts.get(spec.instance_id) ?? 0) + 1;
    attempts.set(spec.instance_id, attempt);
    providerAttempts++;
    if (providerAttempts > dynamicLimit)
      throw new Error(`workflow exceeds ${dynamicLimit} provider attempts`);
    const inputs = spec.inputs ?? baseInputs(spec.node.id);
    const inputDigest = digest({
      inputs: inputs.map(({ envelope }) => envelope.output_digest),
      item: spec.item,
    });
    const resolvedTier = resolveTier(spec.node.tier ?? "standard");
    const base = {
      run_id: runId,
      workflow_digest: workflowHash,
      node_id: spec.node.id,
      instance_id: spec.instance_id,
      parent_node: spec.parent_node,
      item_key: spec.item_key,
      item_digest: spec.item_digest,
      attempt,
      loop_iteration: spec.loop_iteration ?? 1,
      input_digest: inputDigest,
      execution_tier: resolvedTier.tier ?? spec.node.tier ?? "standard",
    };
    emit("node_instance_started", {
      node_id: spec.node.id,
      instance_id: spec.instance_id,
      attempt,
      item_key: spec.item_key,
      execution_tier: base.execution_tier,
    });
    try {
      const result = await execute({
        node: spec.node,
        inputs,
        item: spec.item,
        item_key: spec.item_key,
        item_digest: spec.item_digest,
        instance_id: spec.instance_id,
        attempt,
        loop_iteration: spec.loop_iteration ?? 1,
        sessionId: randomUUID(),
        workflowDigest: workflowHash,
        execution: resolvedTier,
      });
      const payload = result?.payload ?? result ?? {};
      const outputCore = {
        payload,
        findings: result?.findings ?? payload.findings ?? [],
        evidence_refs: result?.evidence_refs ?? [],
        ownership: result?.ownership ?? {},
        changed_paths: result?.changed_paths ?? [],
        command_evidence: result?.command_evidence ?? [],
        resource_usage: result?.resource_usage ?? {},
        selection: result?.selection ?? null,
        quorum: result?.quorum ?? null,
        convergence: result?.convergence ?? null,
      };
      const envelope = freezeEnvelope({
        ...base,
        status: result?.status ?? "passed",
        payload,
        ...outputCore,
        output_digest: digest(outputCore),
      });
      persistEnvelope(runDir, envelope);
      return envelope;
    } catch (error) {
      const envelope = failureEnvelope(base, error);
      persistEnvelope(runDir, envelope);
      emit("node_instance_attempt_failed", {
        node_id: spec.node.id,
        instance_id: spec.instance_id,
        attempt,
        message: envelope.failure.message,
      });
      if (attempt < attemptsLimit && !stopRequested()) return invoke(spec);
      return envelope;
    }
  }

  function launch(spec) {
    pending.delete(spec.instance_id);
    if (spec.node.resource) busyResources.add(spec.node.resource);
    const promise = invoke(spec)
      .then((envelope) => ({ spec, envelope }))
      .finally(() => {
        if (spec.node.resource) busyResources.delete(spec.node.resource);
      });
    running.set(spec.instance_id, { spec, promise });
  }

  while (!isSettled(workflow.terminal_node) || running.size || pending.size) {
    if (stopRequested()) return { status: "stopped", completed, workflow_digest: workflowHash };
    discover();
    if (fatal && running.size === 0) throw fatal;
    const writerRunning = [...running.values()].some(({ spec }) => spec.node.access === "write");
    const candidates = [...pending.values()].sort((left, right) =>
      left.instance_id.localeCompare(right.instance_id),
    );
    const writer = candidates.find(({ node }) => node.access === "write");
    if (!writerRunning && running.size === 0 && writer) launch(writer);
    else if (!writerRunning && !writer) {
      for (const spec of candidates) {
        if (running.size >= concurrency) break;
        if (
          spec.node.access === "write" ||
          (spec.node.resource && busyResources.has(spec.node.resource))
        )
          continue;
        launch(spec);
      }
    }
    if (running.size === 0) {
      if (fatal) throw fatal;
      if (isSettled(workflow.terminal_node)) break;
      throw new Error(
        `workflow cannot make progress; completed: ${[...completed.keys()].sort().join(", ")}`,
      );
    }
    const settled = await Promise.race([...running.values()].map(({ promise }) => promise));
    running.delete(settled.spec.instance_id);
    addCompleted(settled.envelope);
    emit("node_instance_completed", {
      node_id: settled.spec.node.id,
      instance_id: settled.spec.instance_id,
      status: settled.envelope.status,
      item_key: settled.envelope.item_key,
      execution_tier: settled.envelope.execution_tier,
    });
    streamSuccessors(settled.spec, settled.envelope);
    const loopContinued = advanceUntilDry(settled.spec, settled.envelope);
    const collectionError = collectPolicyError(settled.spec.node);
    if (collectionError) fatal = new Error(collectionError);
    if (
      !successful(settled.envelope) &&
      settled.spec.node.failure_handling?.mode !== "collect" &&
      !thresholdToleratesFailure(settled.spec.node) &&
      !loopContinued
    ) {
      fatal = new Error(
        `workflow node instance ${settled.spec.instance_id} failed: ${settled.envelope.failure?.message ?? "failed"}`,
      );
    }
    if (through === settled.spec.node.id && running.size === 0)
      return { status: "through", completed, workflow_digest: workflowHash };
  }
  emit("workflow_completed", { node_id: workflow.terminal_node });
  return { status: "completed", completed, workflow_digest: workflowHash };
}
