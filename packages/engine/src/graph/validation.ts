/** Validates graph records, contracts, temporal bounds, and dependency topology. */
import {
  EDGE_KINDS,
  GRAPH_LIMITS,
  TRUST,
  cachedSourceDigest,
  graphContractValidators,
} from "./core.js";
import type { GraphGraphEdge, GraphGraphNode } from "@rae/contracts";

type Contracts = ReturnType<typeof graphContractValidators>;
type DigestCache = Map<string, string>;
interface SourceRecord {
  source_ref: string;
  source_digest: string;
  logical_id: string;
}

function validateRecordSource(
  record: SourceRecord,
  root: string,
  verifySources: boolean,
  digestCache: DigestCache,
  issues: string[],
): void {
  if (!verifySources || record.source_ref.startsWith("git:")) return;
  try {
    if (cachedSourceDigest(root, record.source_ref, digestCache) !== record.source_digest)
      issues.push(`digest mismatch: ${record.logical_id}`);
  } catch {
    issues.push(`unresolved source: ${record.logical_id}`);
  }
}

function validateNodes(
  nodes: readonly GraphGraphNode[],
  root: string,
  verifySources: boolean,
  digestCache: DigestCache,
  contracts: Contracts,
  ids: Set<string>,
  versions: Set<string>,
  issues: string[],
): void {
  for (const node of nodes) {
    const logicalId = node.logical_id;
    if (!contracts.node(node)) issues.push(`node schema violation: ${logicalId}`);
    if (ids.has(node.logical_id)) issues.push(`duplicate logical node id: ${node.logical_id}`);
    ids.add(node.logical_id);
    if (versions.has(node.version_id)) issues.push(`duplicate version id: ${node.version_id}`);
    versions.add(node.version_id);
    if (!TRUST.has(node.trust_class)) issues.push(`invalid trust class: ${node.logical_id}`);
    if (node.valid_to && node.valid_from && new Date(node.valid_to) < new Date(node.valid_from))
      issues.push(`invalid temporal interval: ${node.logical_id}`);
    validateRecordSource(node, root, verifySources, digestCache, issues);
  }
}

function validateEdges(
  edges: readonly GraphGraphEdge[],
  root: string,
  verifySources: boolean,
  digestCache: DigestCache,
  contracts: Contracts,
  ids: Set<string>,
  versions: Set<string>,
  issues: string[],
): void {
  for (const edge of edges)
    validateEdge(edge, root, verifySources, digestCache, contracts, ids, versions, issues);
}

function validateEdge(
  edge: GraphGraphEdge,
  root: string,
  verifySources: boolean,
  digestCache: DigestCache,
  contracts: Contracts,
  ids: Set<string>,
  versions: Set<string>,
  issues: string[],
): void {
  validateEdgeContract(edge, contracts, issues);
  validateEdgeTopology(edge, ids, versions, issues);
  validateEdgeInterval(edge, issues);
  validateRecordSource(edge, root, verifySources, digestCache, issues);
}

function validateEdgeContract(edge: GraphGraphEdge, contracts: Contracts, issues: string[]): void {
  const logicalId = edge.logical_id;
  if (!contracts.edge(edge)) issues.push(`edge schema violation: ${logicalId}`);
  if (!EDGE_KINDS.has(edge.kind)) issues.push(`invalid edge kind: ${edge.logical_id}`);
}

function validateEdgeTopology(
  edge: GraphGraphEdge,
  ids: Set<string>,
  versions: Set<string>,
  issues: string[],
): void {
  if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`orphan edge: ${edge.logical_id}`);
  if (versions.has(edge.version_id)) issues.push(`duplicate version id: ${edge.version_id}`);
  versions.add(edge.version_id);
}

function validateEdgeInterval(edge: GraphGraphEdge, issues: string[]): void {
  if (edge.valid_to && edge.valid_from && new Date(edge.valid_to) < new Date(edge.valid_from))
    issues.push(`invalid temporal interval: ${edge.logical_id}`);
}

export function validateGraph(
  nodes: readonly GraphGraphNode[],
  edges: readonly GraphGraphEdge[],
  root: string,
  {
    verifySources = true,
    digestCache = new Map(),
  }: {
    verifySources?: boolean;
    digestCache?: DigestCache;
  } = {},
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const contracts = graphContractValidators();
  const repositoryIds = new Set([...nodes, ...edges].map((record) => record.repository_id));
  if (repositoryIds.size > 1) issues.push("cross-repository records are not allowed");
  const ids = new Set<string>();
  const versions = new Set<string>();
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

export function hasDependencyCycle(
  edges: readonly Pick<GraphGraphEdge, "kind" | "from" | "to">[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges.filter((item) => item.kind === "DEPENDS_ON")) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)?.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }];
    visiting.add(start);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
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

function traversedEvidenceKinds(
  requirementId: string,
  adjacency: ReadonlyMap<string, string[]>,
  byId: ReadonlyMap<string, GraphGraphNode>,
): Set<string> {
  const seen = new Set([requirementId]);
  let frontier: string[] = [requirementId];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const neighbor of adjacency.get(id) ?? [])
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
    frontier = next;
  }
  const kinds = new Set<string>();
  for (const id of seen) {
    const kind = byId.get(id)?.kind;
    if (kind) kinds.add(kind);
  }
  return kinds;
}

function mustRequirementPathIssues(
  nodes: readonly GraphGraphNode[],
  edges: readonly GraphGraphEdge[],
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const byId = new Map(nodes.map((node) => [node.logical_id, node]));
  const requiredKinds = ["PlanTask", "TestCase", "CommandExecution", "GateDecision"];
  const issues: string[] = [];
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
