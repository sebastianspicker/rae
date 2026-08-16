/** Compiles guided workflow v2.1 templates and diagnoses candidate topology without execution. */
import { resolveExecutionTier, validateExecutionProfile } from "./execution-profile.mjs";
import { validateWorkflow } from "./workflow-contract.mjs";

const DEFAULT_BUDGETS = Object.freeze({
  max_concurrency: 4,
  max_repair_rounds: 3,
  max_attempts_per_node: 2,
  max_dynamic_instances: 32,
  max_pipeline_depth: 4,
  max_map_items: 16,
});

const TEMPLATE_DETAILS = Object.freeze([
  {
    id: "single-agent-verification",
    title: "Single agent with verification",
    description: "One bounded read-only agent followed by a required verification gate.",
  },
  {
    id: "maker-checker-repair",
    title: "Maker-checker repair",
    description: "A guarded writer and independent checker inside a bounded repair loop.",
  },
  {
    id: "parallel-review-quorum",
    title: "Parallel review quorum",
    description: "Independent review lanes converge only after a configured quorum succeeds.",
  },
  {
    id: "mapped-work",
    title: "Mapped work with one writer",
    description: "Bounded item mapping informs one checkpointed, serialized writer.",
  },
  {
    id: "bounded-until-dry-loop",
    title: "Bounded until-dry discovery",
    description: "Deduplicated discovery repeats only to a declared iteration bound or until dry.",
  },
]);

function integerOption(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`template option must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function templateBudgets(options = {}) {
  return {
    max_concurrency: integerOption(options.max_concurrency, DEFAULT_BUDGETS.max_concurrency, 1, 4),
    max_repair_rounds: integerOption(
      options.max_repair_rounds,
      DEFAULT_BUDGETS.max_repair_rounds,
      0,
      5,
    ),
    max_attempts_per_node: integerOption(
      options.max_attempts_per_node,
      DEFAULT_BUDGETS.max_attempts_per_node,
      1,
      3,
    ),
    max_dynamic_instances: integerOption(
      options.max_dynamic_instances,
      DEFAULT_BUDGETS.max_dynamic_instances,
      1,
      128,
    ),
    max_pipeline_depth: integerOption(
      options.max_pipeline_depth,
      DEFAULT_BUDGETS.max_pipeline_depth,
      1,
      4,
    ),
    max_map_items: integerOption(options.max_map_items, DEFAULT_BUDGETS.max_map_items, 1, 32),
  };
}

function workflowIdentity(templateId, options) {
  const detail = TEMPLATE_DETAILS.find(({ id }) => id === templateId);
  const workflowId = options.workflow_id ?? templateId;
  if (typeof workflowId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(workflowId)) {
    throw new Error("template workflow_id must be a valid workflow identifier");
  }
  return {
    schema_version: "2.1.0",
    workflow_id: workflowId,
    revision: integerOption(options.revision, 1, 1, Number.MAX_SAFE_INTEGER),
    title: options.title ?? detail.title,
    budgets: templateBudgets(options),
  };
}

function singleAgentVerification(identity) {
  return {
    ...identity,
    entry_node: "work",
    terminal_node: "complete",
    nodes: [
      {
        id: "work",
        kind: "agent",
        access: "read",
        tier: "standard",
        guidance: "Perform the bounded task and report evidence.",
      },
      {
        id: "verify",
        kind: "gate",
        access: "control",
        guidance: "Reject missing or blocking verification evidence.",
        verification: true,
      },
      {
        id: "complete",
        kind: "terminal",
        access: "control",
        guidance: "Record verified completion.",
      },
    ],
    edges: [
      { from: "work", to: "verify", type: "artifact", artifact: "work-result" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

function makerCheckerRepair(identity, options) {
  const iterations = integerOption(options.max_iterations, 3, 1, 5);
  return {
    ...identity,
    entry_node: "plan",
    terminal_node: "complete",
    nodes: [
      {
        id: "plan",
        kind: "agent",
        access: "read",
        tier: "judgment",
        guidance: "Produce an ownership-bounded repair plan and verification criteria.",
        ownership_plan: true,
      },
      {
        id: "mutation-checkpoint",
        kind: "checkpoint",
        access: "control",
        guidance: "Require the configured human mutation decision.",
        mutation_checkpoint: true,
      },
      {
        id: "repair-loop",
        kind: "loop",
        access: "control",
        guidance: "Bound maker-checker repair iterations.",
        loop: { mode: "bounded", max_iterations: iterations, members: ["make", "check"] },
      },
      {
        id: "make",
        kind: "agent",
        access: "write",
        tier: "judgment",
        guidance: "Apply only the approved, plan-owned repair.",
      },
      {
        id: "check",
        kind: "agent",
        access: "read",
        tier: "standard",
        guidance: "Independently check the repair and report blocking findings.",
      },
      {
        id: "verify",
        kind: "gate",
        access: "control",
        guidance: "Require a passing checker result before completion.",
        verification: true,
      },
      {
        id: "complete",
        kind: "terminal",
        access: "control",
        guidance: "Record verified repair completion.",
      },
    ],
    edges: [
      { from: "plan", to: "mutation-checkpoint", type: "sequence" },
      { from: "mutation-checkpoint", to: "repair-loop", type: "sequence" },
      { from: "repair-loop", to: "make", type: "sequence" },
      { from: "make", to: "check", type: "artifact", artifact: "repair-result" },
      { from: "check", to: "make", type: "loop-back" },
      { from: "check", to: "verify", type: "artifact", artifact: "checker-findings" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

function parallelReviewQuorum(identity, options) {
  const threshold = integerOption(options.quorum_threshold, 2, 1, 3);
  return {
    ...identity,
    entry_node: "brief",
    terminal_node: "complete",
    nodes: [
      {
        id: "brief",
        kind: "agent",
        access: "read",
        tier: "standard",
        guidance: "Extract reviewable claims and required evidence.",
      },
      {
        id: "contracts",
        kind: "agent",
        access: "read",
        tier: "judgment",
        guidance: "Review public, persistence, and compatibility contracts.",
        failure_handling: { mode: "collect", max_failures: 1 },
      },
      {
        id: "safety",
        kind: "agent",
        access: "read",
        tier: "judgment",
        guidance: "Review safety boundaries and failure containment.",
        failure_handling: { mode: "collect", max_failures: 1 },
      },
      {
        id: "tests",
        kind: "agent",
        access: "read",
        tier: "standard",
        guidance: "Review verification coverage and evidence quality.",
        failure_handling: { mode: "collect", max_failures: 1 },
      },
      {
        id: "review-quorum",
        kind: "join",
        access: "control",
        guidance: "Require the configured number of successful independent reviews.",
        join: "quorum",
        quorum: { threshold },
      },
      {
        id: "verify",
        kind: "gate",
        access: "control",
        guidance: "Reject blocking quorum findings.",
        verification: true,
      },
      {
        id: "complete",
        kind: "terminal",
        access: "control",
        guidance: "Record reviewed completion.",
      },
    ],
    edges: [
      { from: "brief", to: "contracts", type: "artifact", artifact: "review-brief" },
      { from: "brief", to: "safety", type: "artifact", artifact: "review-brief" },
      { from: "brief", to: "tests", type: "artifact", artifact: "review-brief" },
      { from: "contracts", to: "review-quorum", type: "artifact", artifact: "review-findings" },
      { from: "safety", to: "review-quorum", type: "artifact", artifact: "review-findings" },
      { from: "tests", to: "review-quorum", type: "artifact", artifact: "review-findings" },
      { from: "review-quorum", to: "verify", type: "sequence" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

function mappedWork(identity, options) {
  const maxItems = integerOption(options.max_map_items, identity.budgets.max_map_items, 1, 32);
  return {
    ...identity,
    entry_node: "inventory",
    terminal_node: "complete",
    nodes: [
      {
        id: "inventory",
        kind: "agent",
        access: "read",
        tier: "economy",
        guidance: "Return bounded work items with stable item_id fields.",
      },
      {
        id: "analyze-item",
        kind: "map",
        access: "read",
        tier: "standard",
        guidance: "Analyze one mapped work item, its affected contracts, and verification needs.",
        map: { source_pointer: "/items", stable_key_pointer: "/item_id", max_items: maxItems },
      },
      {
        id: "plan",
        kind: "agent",
        access: "read",
        tier: "judgment",
        guidance: "Produce one ownership plan for the serialized writer.",
        ownership_plan: true,
      },
      {
        id: "mutation-checkpoint",
        kind: "checkpoint",
        access: "control",
        guidance: "Require the configured human mutation decision.",
        mutation_checkpoint: true,
      },
      {
        id: "apply",
        kind: "agent",
        access: "write",
        tier: "judgment",
        guidance: "Apply only the plan-owned work and capture verification evidence.",
      },
      {
        id: "verify",
        kind: "gate",
        access: "control",
        guidance: "Reject missing or blocking work verification evidence.",
        verification: true,
      },
      {
        id: "complete",
        kind: "terminal",
        access: "control",
        guidance: "Record verified mapped-work completion.",
      },
    ],
    edges: [
      { from: "inventory", to: "analyze-item", type: "artifact", artifact: "work-items" },
      { from: "analyze-item", to: "plan", type: "artifact", artifact: "item-analysis" },
      { from: "plan", to: "mutation-checkpoint", type: "sequence" },
      { from: "mutation-checkpoint", to: "apply", type: "sequence" },
      { from: "apply", to: "verify", type: "artifact", artifact: "work-result" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

function boundedUntilDryLoop(identity, options) {
  const iterations = integerOption(options.max_iterations, 5, 1, 5);
  return {
    ...identity,
    entry_node: "discovery-loop",
    terminal_node: "complete",
    nodes: [
      {
        id: "discovery-loop",
        kind: "loop",
        access: "control",
        guidance: "Track globally seen discovery keys and stop on dry output.",
        loop: {
          mode: "until-dry",
          max_iterations: iterations,
          members: ["discover", "assess"],
          source_pointer: "/items",
          stable_key_pointer: "/id",
        },
      },
      {
        id: "discover",
        kind: "agent",
        access: "read",
        tier: "standard",
        guidance:
          "Return bounded candidate items with stable id fields, excluding previously seen keys.",
      },
      {
        id: "assess",
        kind: "agent",
        access: "read",
        tier: "judgment",
        guidance:
          "Assess the round and return the next bounded candidate set. Return an empty items array when dry.",
      },
      {
        id: "verify",
        kind: "gate",
        access: "control",
        guidance: "Require converged discovery evidence before completion.",
        verification: true,
      },
      {
        id: "complete",
        kind: "terminal",
        access: "control",
        guidance: "Record verified discovery completion.",
      },
    ],
    edges: [
      { from: "discovery-loop", to: "discover", type: "sequence" },
      { from: "discover", to: "assess", type: "artifact", artifact: "round-findings" },
      { from: "assess", to: "discover", type: "loop-back" },
      { from: "assess", to: "verify", type: "artifact", artifact: "converged-findings" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

const COMPILERS = new Map([
  ["single-agent-verification", singleAgentVerification],
  ["maker-checker-repair", makerCheckerRepair],
  ["parallel-review-quorum", parallelReviewQuorum],
  ["mapped-work", mappedWork],
  ["bounded-until-dry-loop", boundedUntilDryLoop],
]);

/** Lists the fixed, data-only templates available to an operator. */
export function listWorkflowTemplates() {
  return TEMPLATE_DETAILS.map((template) => ({ ...template }));
}

/** Compiles one guided template to an ordinary, validated workflow v2.1 object. */
export function compileWorkflowTemplate(templateId, options = {}) {
  const compiler = typeof templateId === "string" ? COMPILERS.get(templateId) : undefined;
  if (!compiler) throw new Error("unknown workflow template");
  const workflow = compiler(workflowIdentity(templateId, options), options);
  return validateWorkflow(workflow);
}

function diagnostic(kind, message, nodeId = null) {
  return nodeId ? { kind, message, node_id: nodeId } : { kind, message };
}

function workflowNodes(value) {
  if (!Array.isArray(value?.nodes)) return [];
  return value.nodes.filter(
    (node) => node && typeof node === "object" && typeof node.id === "string",
  );
}

function topologyGraph(value) {
  const nodes = workflowNodes(value);
  const ids = new Set(nodes.map(({ id }) => id));
  const outgoing = new Map([...ids].map((id) => [id, []]));
  const incoming = new Map([...ids].map((id) => [id, []]));
  const diagnostics = [];
  return { nodes, ids, outgoing, incoming, diagnostics };
}

function addTopologyEdges(value, graph) {
  const { ids, outgoing, incoming, diagnostics } = graph;
  for (const edge of Array.isArray(value?.edges) ? value.edges : []) {
    if (!edge || typeof edge !== "object") {
      diagnostics.push(diagnostic("topology", "edge must be an object"));
      continue;
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      diagnostics.push(
        diagnostic(
          "topology",
          `edge ${edge.from ?? "missing"} -> ${edge.to ?? "missing"} references an unknown node`,
        ),
      );
      continue;
    }
    if (edge.type === "loop-back") continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
}

function reachableNodes(value, graph) {
  const { ids, outgoing, diagnostics } = graph;
  const reachable = new Set();
  if (typeof value?.entry_node === "string" && ids.has(value.entry_node)) {
    const stack = [value.entry_node];
    while (stack.length) {
      const current = stack.pop();
      if (reachable.has(current)) continue;
      reachable.add(current);
      stack.push(...(outgoing.get(current) ?? []));
    }
  } else {
    diagnostics.push(diagnostic("topology", "entry node is missing or unknown"));
  }
  return reachable;
}

function addEndpointDiagnostics(value, graph) {
  const { ids, incoming, outgoing, diagnostics } = graph;
  if (typeof value?.terminal_node !== "string" || !ids.has(value.terminal_node)) {
    diagnostics.push(diagnostic("topology", "terminal node is missing or unknown"));
  }
  if (typeof value?.entry_node === "string" && (incoming.get(value.entry_node) ?? []).length) {
    diagnostics.push(diagnostic("topology", "entry node has predecessors", value.entry_node));
  }
  if (
    typeof value?.terminal_node === "string" &&
    (outgoing.get(value.terminal_node) ?? []).length
  ) {
    diagnostics.push(diagnostic("topology", "terminal node has successors", value.terminal_node));
  }
}

function addCycleDiagnostics(graph) {
  const { ids, outgoing, diagnostics } = graph;
  const active = new Set();
  const complete = new Set();
  function visit(id) {
    if (active.has(id)) {
      diagnostics.push(diagnostic("topology", `unbounded cycle includes ${id}`, id));
      return;
    }
    if (complete.has(id)) return;
    active.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    active.delete(id);
    complete.add(id);
  }
  for (const id of ids) visit(id);
}

function topology(value) {
  const graph = topologyGraph(value);
  if (graph.ids.size !== graph.nodes.length) {
    graph.diagnostics.push(diagnostic("topology", "node ids must be unique"));
  }
  addTopologyEdges(value, graph);
  const reachable = reachableNodes(value, graph);
  addEndpointDiagnostics(value, graph);
  addCycleDiagnostics(graph);
  return { ...graph, reachable };
}

function dominators(value, graph) {
  const all = new Set(graph.ids);
  const result = new Map(
    [...graph.ids].map((id) => [id, id === value?.entry_node ? new Set([id]) : new Set(all)]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of graph.ids) {
      if (id === value?.entry_node) continue;
      const parents = graph.incoming.get(id) ?? [];
      const intersection = new Set(all);
      for (const parent of parents) {
        for (const entry of intersection) {
          if (!result.get(parent)?.has(entry)) intersection.delete(entry);
        }
      }
      const next = new Set([id, ...intersection]);
      const prior = result.get(id);
      if (next.size !== prior.size || [...next].some((entry) => !prior.has(entry))) {
        result.set(id, next);
        changed = true;
      }
    }
  }
  return result;
}

function verificationReport(value, graph, dominatorMap) {
  const verificationIds = graph.nodes
    .filter((node) => node.verification === true)
    .map(({ id }) => id);
  const terminalId = value?.terminal_node;
  const terminalDominated =
    typeof terminalId === "string" && graph.ids.has(terminalId)
      ? verificationIds.some((id) => dominatorMap.get(terminalId)?.has(id))
      : false;
  const diagnostics = [];
  if (!verificationIds.length) diagnostics.push("workflow declares no verification node");
  if (!terminalDominated) diagnostics.push("terminal paths are not dominated by verification");
  return {
    required: !terminalDominated,
    node_ids: verificationIds,
    terminal_dominated: terminalDominated,
    diagnostics,
  };
}

function unsafeWriters(graph, dominatorMap, verification) {
  const ownership = new Set(
    graph.nodes.filter((node) => node.ownership_plan === true).map(({ id }) => id),
  );
  const checkpoints = new Set(
    graph.nodes.filter((node) => node.mutation_checkpoint === true).map(({ id }) => id),
  );
  return graph.nodes
    .filter((node) => node.access === "write")
    .map((writer) => {
      const dominates = dominatorMap.get(writer.id) ?? new Set();
      const reasons = [];
      if (!graph.reachable.has(writer.id)) reasons.push("writer is unreachable from entry");
      if (![...ownership].some((id) => dominates.has(id)))
        reasons.push("missing ownership-plan dominance");
      if (![...checkpoints].some((id) => dominates.has(id)))
        reasons.push("missing mutation-checkpoint dominance");
      if (verification.required) reasons.push("terminal path is not verification-dominated");
      return reasons.length ? { node_id: writer.id, reasons } : null;
    })
    .filter(Boolean);
}

function workflowBudgetEstimate(value) {
  const budgets = value?.budgets && typeof value.budgets === "object" ? value.budgets : {};
  return {
    attemptsPerNode: Number.isInteger(budgets.max_attempts_per_node)
      ? budgets.max_attempts_per_node
      : 1,
    dynamicLimit: Number.isInteger(budgets.max_dynamic_instances)
      ? budgets.max_dynamic_instances
      : 1,
    mapDefault: Number.isInteger(budgets.max_map_items) ? budgets.max_map_items : 1,
    concurrencyBound: Number.isInteger(budgets.max_concurrency) ? budgets.max_concurrency : 1,
  };
}

function loopIterationLimits(nodes) {
  const loopIterations = new Map();
  for (const loop of nodes.filter((node) => node.kind === "loop")) {
    const iterations = Number.isInteger(loop.loop?.max_iterations) ? loop.loop.max_iterations : 1;
    for (const member of loop.loop?.members ?? []) loopIterations.set(member, iterations);
  }
  return loopIterations;
}

function instanceEstimate(nodes, loopIterations, mapDefault) {
  let dynamicInstances = 0;
  let logicalInstances = 0;
  for (const node of nodes) {
    const iterations = loopIterations.get(node.id) ?? 1;
    const mapped = node.kind === "map" ? (node.map?.max_items ?? mapDefault) : 1;
    logicalInstances += iterations * mapped;
    if (node.kind === "map") dynamicInstances += iterations * mapped;
  }
  return { dynamicInstances, logicalInstances };
}

function estimates(value, graph) {
  const { attemptsPerNode, dynamicLimit, mapDefault, concurrencyBound } =
    workflowBudgetEstimate(value);
  const instances = instanceEstimate(graph.nodes, loopIterationLimits(graph.nodes), mapDefault);
  return {
    estimated_max_attempts: instances.logicalInstances * attemptsPerNode,
    estimated_dynamic_instances: Math.min(instances.dynamicInstances, dynamicLimit),
    dynamic_instance_limit: dynamicLimit,
    concurrency_bound: concurrencyBound,
  };
}

function executionRoutes(value, executionProfile, diagnostics) {
  if (!executionProfile) return [];
  let profile;
  try {
    profile = validateExecutionProfile(executionProfile);
  } catch (error) {
    diagnostics.push(diagnostic("execution-profile", error.message));
    return [];
  }
  return workflowNodes(value)
    .filter((node) => ["agent", "map"].includes(node.kind))
    .map((node) => ({
      node_id: node.id,
      ...resolveExecutionTier(profile, node.tier ?? "standard", node.id),
    }));
}

/** Diagnoses a workflow candidate without executing, drafting, or mutating a registry. */
export function analyzeWorkflow(value, options = {}) {
  const schemaDiagnostics = [];
  try {
    validateWorkflow(value);
  } catch (error) {
    schemaDiagnostics.push(diagnostic("schema", error.message));
  }
  const graph = topology(value);
  const dominatorMap = dominators(value, graph);
  const missingVerification = verificationReport(value, graph, dominatorMap);
  const executionDiagnostics = [];
  const estimatesResult = estimates(value, graph);
  return {
    valid: schemaDiagnostics.length === 0 && graph.diagnostics.length === 0,
    schema_diagnostics: schemaDiagnostics,
    topology_diagnostics: graph.diagnostics,
    unreachable_nodes: graph.nodes.filter(({ id }) => !graph.reachable.has(id)).map(({ id }) => id),
    unsafe_writer_paths: unsafeWriters(graph, dominatorMap, missingVerification),
    missing_verification: missingVerification,
    ...estimatesResult,
    execution_routes: executionRoutes(
      value,
      options.execution_profile ?? options.executionProfile,
      executionDiagnostics,
    ),
    execution_profile_diagnostics: executionDiagnostics,
    monetary_cost: { status: "unavailable" },
  };
}
