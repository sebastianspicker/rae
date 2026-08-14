/** Validates graph records, contracts, temporal bounds, and dependency topology. */
import { EDGE_KINDS, GRAPH_LIMITS, TRUST, graphContractValidators, sourceDigest } from "./core.mjs";

function validateRecordSource(record, root, verifySources, issues) {
  if (!verifySources || record.source_ref.startsWith("git:")) return;
  try {
    if (sourceDigest(root, record.source_ref) !== record.source_digest)
      issues.push(`digest mismatch: ${record.logical_id}`);
  } catch {
    issues.push(`unresolved source: ${record.logical_id}`);
  }
}

function validateNodes(nodes, root, verifySources, contracts, ids, versions, issues) {
  for (const node of nodes) {
    if (!contracts.node(node)) issues.push(`node schema violation: ${node.logical_id}`);
    if (ids.has(node.logical_id)) issues.push(`duplicate logical node id: ${node.logical_id}`);
    ids.add(node.logical_id);
    if (versions.has(node.version_id)) issues.push(`duplicate version id: ${node.version_id}`);
    versions.add(node.version_id);
    if (!TRUST.has(node.trust_class)) issues.push(`invalid trust class: ${node.logical_id}`);
    if (node.valid_to && new Date(node.valid_to) < new Date(node.valid_from))
      issues.push(`invalid temporal interval: ${node.logical_id}`);
    validateRecordSource(node, root, verifySources, issues);
  }
}

function validateEdges(edges, root, verifySources, contracts, ids, versions, issues) {
  for (const edge of edges)
    validateEdge(edge, root, verifySources, contracts, ids, versions, issues);
}

function validateEdge(edge, root, verifySources, contracts, ids, versions, issues) {
  validateEdgeContract(edge, contracts, issues);
  validateEdgeTopology(edge, ids, versions, issues);
  validateEdgeInterval(edge, issues);
  validateRecordSource(edge, root, verifySources, issues);
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

export function validateGraph(nodes, edges, root, { verifySources = true } = {}) {
  const issues = [];
  const contracts = graphContractValidators();
  const repositoryIds = new Set([...nodes, ...edges].map((record) => record.repository_id));
  if (repositoryIds.size > 1) issues.push("cross-repository records are not allowed");
  const ids = new Set();
  const versions = new Set();
  validateNodes(nodes, root, verifySources, contracts, ids, versions, issues);
  validateEdges(edges, root, verifySources, contracts, ids, versions, issues);
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

function hasDependencyCycle(edges) {
  const adjacency = new Map();
  for (const edge of edges.filter((item) => item.kind === "DEPENDS_ON"))
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...adjacency.keys()].some(visit);
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
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
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
