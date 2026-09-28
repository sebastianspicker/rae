/** Validates graph records, contracts, temporal bounds, and dependency topology. */
import {
  EDGE_KINDS,
  GRAPH_LIMITS,
  TRUST,
  cachedSourceDigest,
  graphContractValidators,
} from "./core.mjs";

function validateRecordSource(record, root, verifySources, digestCache, issues) {
  if (!verifySources || record.source_ref.startsWith("git:")) return;
  try {
    if (cachedSourceDigest(root, record.source_ref, digestCache) !== record.source_digest)
      issues.push(`digest mismatch: ${record.logical_id}`);
  } catch {
    issues.push(`unresolved source: ${record.logical_id}`);
  }
}

function validateNodes(nodes, root, verifySources, digestCache, contracts, ids, versions, issues) {
  for (const node of nodes) {
    if (!contracts.node(node)) issues.push(`node schema violation: ${node.logical_id}`);
    if (ids.has(node.logical_id)) issues.push(`duplicate logical node id: ${node.logical_id}`);
    ids.add(node.logical_id);
    if (versions.has(node.version_id)) issues.push(`duplicate version id: ${node.version_id}`);
    versions.add(node.version_id);
    if (!TRUST.has(node.trust_class)) issues.push(`invalid trust class: ${node.logical_id}`);
    if (node.valid_to && new Date(node.valid_to) < new Date(node.valid_from))
      issues.push(`invalid temporal interval: ${node.logical_id}`);
    validateRecordSource(node, root, verifySources, digestCache, issues);
  }
}

function validateEdges(edges, root, verifySources, digestCache, contracts, ids, versions, issues) {
  for (const edge of edges)
    validateEdge(edge, root, verifySources, digestCache, contracts, ids, versions, issues);
}

function validateEdge(edge, root, verifySources, digestCache, contracts, ids, versions, issues) {
  validateEdgeContract(edge, contracts, issues);
  validateEdgeTopology(edge, ids, versions, issues);
  validateEdgeInterval(edge, issues);
  validateRecordSource(edge, root, verifySources, digestCache, issues);
}

function validateEdgeContract(edge, contracts, issues) {
  if (!contracts.edge(edge)) issues.push(`edge schema violation: ${edge.logical_id}`);
  if (!EDGE_KINDS.has(edge.kind)) issues.push(`invalid edge kind: ${edge.logical_id}`);
}

function validateEdgeTopology(edge, ids, versions, issues) {
  if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`orphan edge: ${edge.logical_id}`);
  if (versions.has(edge.version_id)) issues.push(`duplicate version id: ${edge.version_id}`);
  versions.add(edge.version_id);
}

function validateEdgeInterval(edge, issues) {
  if (edge.valid_to && new Date(edge.valid_to) < new Date(edge.valid_from))
    issues.push(`invalid temporal interval: ${edge.logical_id}`);
}

export function validateGraph(
  nodes,
  edges,
  root,
  { verifySources = true, digestCache = new Map() } = {},
) {
  const issues = [];
  const contracts = graphContractValidators();
  const repositoryIds = new Set([...nodes, ...edges].map((record) => record.repository_id));
  if (repositoryIds.size > 1) issues.push("cross-repository records are not allowed");
  const ids = new Set();
  const versions = new Set();
  validateNodes(nodes, root, verifySources, digestCache, contracts, ids, versions, issues);
  validateEdges(edges, root, verifySources, digestCache, contracts, ids, versions, issues);
  if (nodes.length > GRAPH_LIMITS.maxNodes) issues.push(`node limit exceeded: ${nodes.length}`);
  if (edges.length > GRAPH_LIMITS.maxEdges) issues.push(`edge limit exceeded: ${edges.length}`);
  if (hasDependencyCycle(edges)) issues.push("dependency cycle detected");
  if (
    nodes.some(
      (node) => node.kind === "GateDecision" && node.attributes.phase === "release-readiness",
    )
  ) {
    issues.push(...mustRequirementPathIssues(nodes, edges));
  }
  return { valid: issues.length === 0, issues };
}

export function hasDependencyCycle(edges) {
  const adjacency = new Map();
  for (const edge of edges.filter((item) => item.kind === "DEPENDS_ON")) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const visiting = new Set();
  const visited = new Set();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack = [{ id: start, index: 0 }];
    visiting.add(start);
    while (stack.length) {
      const frame = stack.at(-1);
      const neighbors = adjacency.get(frame.id) ?? [];
      if (frame.index >= neighbors.length) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.index++];
      if (visiting.has(next)) return true;
      if (visited.has(next)) continue;
      visiting.add(next);
      stack.push({ id: next, index: 0 });
    }
  }
  return false;
}

function traversedEvidenceKinds(requirementId, adjacency, byId) {
  const seen = new Set([requirementId]);
  let frontier = [requirementId];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier)
      for (const neighbor of adjacency.get(id) ?? [])
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
    frontier = next;
  }
  return new Set([...seen].map((id) => byId.get(id)?.kind).filter(Boolean));
}

function mustRequirementPathIssues(nodes, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }
  const byId = new Map(nodes.map((node) => [node.logical_id, node]));
  const requiredKinds = ["PlanTask", "TestCase", "CommandExecution", "GateDecision"];
  const issues = [];
  for (const requirement of nodes.filter(
    (node) => node.kind === "Requirement" && node.attributes.priority === "must",
  )) {
    const found = traversedEvidenceKinds(requirement.logical_id, adjacency, byId);
    const missing = requiredKinds.filter((kind) => !found.has(kind));
    if (missing.length)
      issues.push(
        `MUST requirement lacks traversable evidence path (${missing.join(", ")}): ${requirement.logical_id}`,
      );
  }
  return issues;
}
