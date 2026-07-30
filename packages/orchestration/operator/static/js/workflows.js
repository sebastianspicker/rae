/** Renders and controls the authenticated workflow registry editor. */
import { api, showError, showToast } from "./api.js";
import { currentRun, elements, state } from "./state.js";

const escapeText = (value) => String(value ?? "");
const base = () => `/projects/${encodeURIComponent(state.projectId)}/workflows`;
const firstDefined = (...values) => values.find((value) => value !== undefined);

function selectedRevision() {
  return state.workflow?.revisions?.at(-1)?.revision ?? state.workflow?.workflow?.revision ?? null;
}

function neighborIds(edges, nodeId, direction) {
  return edges
    .filter((edge) => (direction === "to" ? edge.to : edge.from) === nodeId)
    .map((edge) => (direction === "to" ? edge.from : edge.to))
    .sort();
}

function isCollapsibleNode(node) {
  return node.kind === "agent" && node.access === "read";
}

function fanoutSignatures(definition) {
  const edges = definition.edges ?? [];
  const signatures = new Map();
  for (const node of definition.nodes ?? []) {
    if (!isCollapsibleNode(node)) continue;
    const incoming = neighborIds(edges, node.id, "to");
    const outgoing = neighborIds(edges, node.id, "from");
    const signature = `${incoming.join(",")}|${outgoing.join(",")}`;
    if (!signatures.has(signature)) signatures.set(signature, []);
    signatures.get(signature).push(node);
  }
  return new Map(
    [...signatures.values()]
      .filter((group) => group.length > 2)
      .flatMap((group) => group.map((node) => [node.id, group])),
  );
}

function fanoutVertex(group) {
  return {
    id: `fanout:${group
      .map((item) => item.id)
      .sort()
      .join("+")}`,
    kind: "fan-out",
    access: "read",
    tier: group.every((item) => item.tier === group[0].tier) ? group[0].tier : "mixed",
    members: group.map((item) => item.id).sort(),
  };
}

function groupedVertices(definition) {
  const collapsed = fanoutSignatures(definition);
  const emitted = new Set();
  const vertices = [];
  const aliases = new Map();
  for (const node of definition.nodes ?? []) {
    const group = collapsed.get(node.id);
    if (!group) {
      vertices.push({ ...node, members: [node.id] });
      aliases.set(node.id, node.id);
      continue;
    }
    const vertex = fanoutVertex(group);
    aliases.set(node.id, vertex.id);
    if (emitted.has(vertex.id)) continue;
    emitted.add(vertex.id);
    vertices.push(vertex);
  }
  return { vertices, aliases };
}

function topology(definition) {
  const { vertices, aliases } = groupedVertices(definition);
  const edges = normalizedEdges(definition.edges ?? [], vertices, aliases);
  return { vertices, edges, layers: topologyLayers(vertices, edges) };
}

function normalizedEdges(sourceEdges, vertices, aliases) {
  const ids = new Set(vertices.map(({ id }) => id));
  const seen = new Set();
  return sourceEdges.flatMap((edge) => uniqueEdge(edge, ids, aliases, seen));
}

function uniqueEdge(edge, ids, aliases, seen) {
  const from = firstDefined(aliases.get(edge.from), edge.from);
  const to = firstDefined(aliases.get(edge.to), edge.to);
  if (!ids.has(from) || !ids.has(to) || from === to) return [];
  const detail = firstDefined(edge.condition, edge.artifact, "");
  const key = `${from}|${to}|${edge.type}|${detail}`;
  if (seen.has(key)) return [];
  seen.add(key);
  return [{ ...edge, from, to }];
}

function topologyLayers(vertices, edges) {
  const depth = new Map(vertices.map(({ id }) => [id, 0]));
  const acyclic = edges.filter((edge) => edge.type !== "loop-back");
  const incoming = new Map(vertices.map(({ id }) => [id, 0]));
  for (const edge of acyclic) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const queue = [...vertices.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id)].sort();
  while (queue.length) {
    const id = queue.shift();
    advanceTopologyDepth(id, acyclic, depth, incoming, queue);
    queue.sort();
  }
  return groupedLayers(vertices, depth);
}

function advanceTopologyDepth(id, edges, depth, incoming, queue) {
  for (const edge of edges.filter((candidate) => candidate.from === id)) {
    depth.set(edge.to, Math.max(depth.get(edge.to), depth.get(id) + 1));
    incoming.set(edge.to, incoming.get(edge.to) - 1);
    if (incoming.get(edge.to) === 0) queue.push(edge.to);
  }
}

function groupedLayers(vertices, depth) {
  const layers = new Map();
  for (const vertex of vertices) {
    const layer = depth.get(vertex.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(vertex);
  }
  for (const layer of layers.values()) layer.sort((left, right) => left.id.localeCompare(right.id));
  return layers;
}

function renderGraph(definition = {}) {
  const graph = elements["workflow-graph-content"];
  graph.replaceChildren();
  const { vertices, edges, layers } = topology(definition);
  setGraphViewBox(layers);
  const positions = graphPositions(layers);
  renderEdges(graph, edges, positions);
  renderNodes(graph, vertices, positions);
}

function setGraphViewBox(layers) {
  const maximumRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const maximumDepth = Math.max(0, ...layers.keys());
  elements["workflow-graph"].setAttribute(
    "viewBox",
    `0 0 ${Math.max(640, (maximumDepth + 1) * 180 + 30)} ${Math.max(250, maximumRows * 92 + 45)}`,
  );
}

function graphPositions(layers) {
  const positions = new Map();
  for (const [layerIndex, layer] of layers) {
    layer.forEach((node, row) => {
      positions.set(node.id, { x: 20 + layerIndex * 180, y: 24 + row * 92 });
    });
  }
  return positions;
}

function renderEdges(graph, edges, positions) {
  for (const edgeRecord of edges) {
    const from = positions.get(edgeRecord.from);
    const to = positions.get(edgeRecord.to);
    if (!from || !to) continue;
    graph.append(edgePath(edgeRecord, from, to), edgeLabel(edgeRecord, from, to));
  }
}

function edgePath(edgeRecord, from, to) {
  const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
  edge.setAttribute("class", `workflow-edge workflow-edge--${edgeRecord.type}`);
  edge.setAttribute("d", edgePathData(edgeRecord.type, from, to));
  return edge;
}

function edgePathData(type, from, to) {
  const bend = type === "loop-back" ? Math.min(from.y, to.y) - 18 : (from.x + to.x) / 2;
  if (type === "loop-back")
    return `M${from.x + 130} ${from.y + 30} C${from.x + 155} ${bend} ${to.x - 25} ${bend} ${to.x} ${to.y + 30}`;
  return `M${from.x + 130} ${from.y + 30} C${bend} ${from.y + 30} ${bend} ${to.y + 30} ${to.x} ${to.y + 30}`;
}

function edgeLabel(edgeRecord, from, to) {
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", "workflow-edge-label");
  label.setAttribute("x", (from.x + to.x + 130) / 2);
  label.setAttribute("y", (from.y + to.y) / 2 + 20);
  label.textContent = edgeRecord.condition ?? edgeRecord.artifact ?? edgeRecord.type;
  return label;
}

function renderNodes(graph, vertices, positions) {
  for (const node of vertices) {
    const position = positions.get(node.id);
    if (position)
      graph.append(
        nodeRectangle(node, position),
        nodeText(node, position),
        nodeBadge(node, position),
      );
  }
}

function nodeRectangle(node, { x, y }) {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("class", `workflow-node workflow-node--${node.kind}`);
  rect.setAttribute("x", x);
  rect.setAttribute("y", y);
  rect.setAttribute("width", "130");
  rect.setAttribute("height", "60");
  return rect;
}

function nodeText(node, { x, y }) {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", x + 8);
  text.setAttribute("y", y + 24);
  text.textContent = escapeText(
    node.kind === "fan-out" ? `${node.members.length} parallel nodes` : node.id,
  );
  return text;
}

function nodeBadge(node, { x, y }) {
  const badge = document.createElementNS("http://www.w3.org/2000/svg", "text");
  badge.setAttribute("class", "workflow-node-badge");
  badge.setAttribute("x", x + 8);
  badge.setAttribute("y", y + 46);
  badge.textContent = `${node.kind} · ${node.tier ?? node.access}`;
  return badge;
}

function structuredTable(caption, columns, rows) {
  const table = document.createElement("table");
  const captionElement = document.createElement("caption");
  captionElement.textContent = caption;
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    headingRow.append(cell);
  }
  head.append(headingRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = escapeText(value);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(captionElement, head, body);
  return table;
}

function renderStructure(definition) {
  const instances = visibleInstances(definition);
  elements["workflow-structure"].replaceChildren(
    structuredTable(
      "Nodes",
      ["ID", "Kind", "Access", "Tier", "Join or fan-out", "Failure"],
      (definition.nodes ?? []).map(nodeStructureRow),
    ),
    structuredTable(
      "Edges",
      ["From", "To", "Type", "Artifact or condition"],
      (definition.edges ?? []).map(edgeStructureRow),
    ),
    structuredTable(
      "Live and completed node instances",
      ["Instance", "Node", "Status", "Attempt", "Item key", "Tier", "Decision"],
      instances.map(instanceStructureRow),
    ),
  );
}

function visibleInstances(definition) {
  const run = currentRun();
  const matches =
    run?.workflow?.workflow_id === definition.workflow_id ||
    run?.workflow?.digest === state.workflow?.digest;
  return matches ? (run.workflow.instances ?? []) : [];
}

function nodeStructureRow(node) {
  return [
    node.id,
    node.kind,
    node.access,
    node.tier ?? "standard",
    nodeJoinLabel(node),
    node.failure_handling?.mode ?? "fail-workflow",
  ];
}

function nodeJoinLabel(node) {
  if (node.join === "quorum") return `quorum ${node.quorum?.threshold ?? "?"}`;
  return node.join ?? (node.map ? `map ≤${node.map.max_items ?? 32}` : "—");
}

function edgeStructureRow(edge) {
  return [edge.from, edge.to, edge.type, edge.condition ?? edge.artifact ?? "—"];
}

function instanceStructureRow(instance) {
  return [
    instance.instance_id,
    instance.node_id,
    instance.status,
    instance.attempt,
    instance.item_key ?? "—",
    instance.execution_tier,
    instanceDecisionLabel(instance),
  ];
}

function instanceDecisionLabel(instance) {
  if (instance.selection) return `selected ${instance.selection.winner ?? "input"}`;
  if (instance.quorum)
    return `quorum ${instance.quorum.passed ?? instance.quorum.accepted ?? "—"}/${instance.quorum.threshold ?? "—"}`;
  return instance.convergence?.dry ? "converged" : "—";
}

function mutationLocked() {
  return state.runs.some(
    (run) => run.runtime_active || ["running", "waiting", "phase-active"].includes(run.status),
  );
}

function updateMutationControls() {
  const locked = mutationLocked();
  for (const control of mutationControls()) {
    control.disabled = locked;
  }
  elements["workflow-definition"].readOnly = locked;
  if (locked)
    elements["workflow-status"].textContent = "Registry is read-only while a run is active.";
}

function mutationControls() {
  return [elements["workflow-draft"], elements["workflow-validate"], elements["workflow-activate"]];
}

function renderWorkflowBudget(definition) {
  elements["workflow-budget"].textContent = definition.budgets
    ? `Budgets: concurrency ${definition.budgets.max_concurrency ?? 4}; map ${definition.budgets.max_map_items ?? 32}; pipeline depth ${definition.budgets.max_pipeline_depth ?? 4}; dynamic instances or attempts ${definition.budgets.max_dynamic_instances ?? 128}; repair rounds ${definition.budgets.max_repair_rounds ?? 5}.`
    : "No explicit revision budgets.";
}

function renderWorkflowDetails(workflow) {
  elements["workflow-details"].replaceChildren(
    ...Object.entries({
      id: workflow.workflow_id,
      active_revision:
        workflow.active?.workflow_id === workflow.workflow_id ? workflow.active.revision : "none",
      latest_revision: selectedRevision() ?? "none",
      digest: workflow.digest,
    }).map(([key, value]) => {
      const box = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = key.replace("_", " ");
      dd.textContent = escapeText(value);
      box.append(dt, dd);
      return box;
    }),
  );
}

function renderWorkflowHistory(workflow) {
  const history = workflow.activation_history ?? [];
  elements["workflow-history"].replaceChildren(
    ...history.map((item) => {
      const li = document.createElement("li");
      li.textContent =
        typeof item === "string"
          ? item
          : `${item.revision ?? "revision"} · ${item.activated_at ?? "recorded"}`;
      return li;
    }),
  );
}

function renderWorkflow() {
  const workflow = state.workflow;
  if (!workflow) return;
  const definition = workflow.workflow ?? {};
  elements["workflow-definition"].value = JSON.stringify(definition, null, 2);
  renderWorkflowBudget(definition);
  renderWorkflowDetails(workflow);
  renderWorkflowHistory(workflow);
  renderGraph(definition);
  renderStructure(definition);
  updateMutationControls();
}

async function selectWorkflow(id) {
  state.workflowId = id;
  state.workflow = (await api(`${base()}/${encodeURIComponent(id)}`)).workflow;
  renderWorkflow();
  [...elements["workflow-list"].querySelectorAll("button")].forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.workflowId === id));
  });
}

export async function loadWorkflows() {
  if (!state.projectId) return;
  elements["workflow-status"].textContent = "Loading workflow registry…";
  const payload = await api(base());
  state.workflows = payload.workflows ?? [];
  elements["workflow-list"].replaceChildren(
    ...state.workflows.map((workflow) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.workflowId = workflow.workflow_id;
      button.textContent = `${workflow.workflow_id} · r${workflow.latest_revision ?? "—"}${workflow.active ? " · active" : ""}`;
      button.addEventListener("click", () => selectWorkflow(workflow.workflow_id).catch(showError));
      return button;
    }),
  );
  elements["workflow-empty"].hidden = state.workflows.length > 0;
  if (state.workflows[0]) await selectWorkflow(state.workflowId ?? state.workflows[0].workflow_id);
  elements["workflow-status"].textContent =
    "Registry loaded. Drafts cannot change while a run is active.";
  updateMutationControls();
}

export function bindWorkflowEditor() {
  elements["workflow-refresh"].addEventListener("click", () => loadWorkflows().catch(showError));
  elements["workflow-draft-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const workflow = JSON.parse(elements["workflow-definition"].value);
      const result = await api(`${base()}/${encodeURIComponent(state.workflowId)}/drafts`, {
        method: "POST",
        body: JSON.stringify({
          workflow,
          expected_revision: selectedRevision(),
          actor: elements["workflow-actor"].value,
          rationale: elements["workflow-rationale"].value,
        }),
      });
      state.workflow.revisions.push(result.revision);
      state.workflow.workflow = result.revision.workflow;
      state.workflow.digest = result.revision.digest;
      showToast("Draft revision saved.", "notice");
      renderWorkflow();
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-validate"].addEventListener("click", async () => {
    try {
      const revision = selectedRevision();
      const result = await api(
        `${base()}/${encodeURIComponent(state.workflowId)}/revisions/${encodeURIComponent(revision)}/validate`,
        { method: "POST", body: "{}" },
      );
      elements["workflow-status"].textContent = `Validation: ${JSON.stringify(result.validation)}`;
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-diff"].addEventListener("click", async () => {
    try {
      const diff = await api(
        `${base()}/${encodeURIComponent(state.workflowId)}/diff?from=${encodeURIComponent(elements["workflow-diff-base"].value)}&to=${encodeURIComponent(selectedRevision())}`,
      );
      elements["workflow-diff-output"].textContent = JSON.stringify(diff.diff, null, 2);
    } catch (error) {
      showError(error);
    }
  });
  elements["workflow-activate"].addEventListener("click", async () => {
    try {
      const revision = selectedRevision();
      const result = await api(
        `${base()}/${encodeURIComponent(state.workflowId)}/revisions/${encodeURIComponent(revision)}/activate`,
        {
          method: "POST",
          body: JSON.stringify({
            digest: elements["workflow-digest-confirmation"].value,
            actor: elements["workflow-actor"].value,
            rationale: elements["workflow-rationale"].value,
          }),
        },
      );
      elements["workflow-status"].textContent =
        `Activated ${result.activation?.revision ?? revision}.`;
      await selectWorkflow(state.workflowId);
    } catch (error) {
      showError(error);
    }
  });
}
