/** Loads, queries, reports on, and explains persisted graph projections. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  atomicWrite,
  canonicalJson,
  credentialLike,
  graphContractValidators,
  graphRunPaths,
  graphRepositoryIdentity,
  graphSnapshotIdentity,
  jsonl,
  readJson,
  safeRegularFile,
  sha256,
  sourceDigest,
} from "./core.mjs";
import { validateGraph } from "./validation.mjs";

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`corrupt JSONL at ${path}:${index + 1}`);
      }
    });
}

export function loadGraph(projectRoot, runId) {
  const root = resolve(projectRoot);
  const selectedRun = selectedGraphRun(root, runId);
  if (!selectedRun) throw new Error("--run-id is required when no active pipeline state exists");
  const { graphDir } = graphRunPaths(root, selectedRun);
  const manifest = loadGraphManifest(graphDir, selectedRun, root);
  const { nodes, edges } = loadGraphRecords(graphDir, manifest);
  validateManifestRecordCounts(manifest, nodes, edges);
  validateLoadedGraph(nodes, edges, root);
  return { root, runId: selectedRun, graphDir, manifest, nodes, edges };
}

function selectedGraphRun(root, runId) {
  if (runId) return runId;
  const statePath = resolve(root, ".pipeline", "pipeline-state.json");
  return existsSync(statePath) ? readJson(statePath).run_id : discoverProjectionRun(root);
}

function loadGraphManifest(graphDir, selectedRun, root) {
  const manifestPath = resolve(graphDir, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error(`graph projection not found for run: ${selectedRun}`);
  const manifest = readJson(manifestPath);
  validateLoadedManifest(manifest, selectedRun, graphRepositoryIdentity(root).repositoryId);
  return manifest;
}

function loadGraphRecords(graphDir, manifest) {
  const nodes = readJsonl(resolve(graphDir, "nodes.jsonl"));
  const edges = readJsonl(resolve(graphDir, "edges.jsonl"));
  if (
    sha256(jsonl(nodes)) !== manifest.nodes_digest ||
    sha256(jsonl(edges)) !== manifest.edges_digest
  )
    throw new Error("graph projection digest mismatch");
  return { nodes, edges };
}

function validateLoadedGraph(nodes, edges, root) {
  const validation = validateGraph(nodes, edges, root, { verifySources: false });
  if (!validation.valid)
    throw new Error(`graph validation failed: ${validation.issues.join("; ")}`);
}

function validateLoadedManifest(manifest, selectedRun, repositoryId) {
  if (!graphContractValidators().manifest(manifest)) {
    throw new Error("graph manifest does not satisfy its contract");
  }
  const { canonical_digest: canonicalDigest, ...manifestCore } = manifest;
  if (canonicalDigest !== sha256(canonicalJson(manifestCore))) {
    throw new Error("graph manifest canonical digest mismatch");
  }
  if (manifest.run_id !== selectedRun) {
    throw new Error("graph manifest run id mismatch");
  }
  if (manifest.repository_id !== repositoryId) {
    throw new Error("graph manifest repository identity mismatch");
  }
}

function validateManifestRecordCounts(manifest, nodes, edges) {
  if (manifest.node_count !== nodes.length || manifest.edge_count !== edges.length) {
    throw new Error("graph manifest record count mismatch");
  }
}

function discoverProjectionRun(root) {
  const runsRoot = resolve(root, ".pipeline", "runs");
  if (!existsSync(runsRoot)) return null;
  const candidates = projectionCandidates(runsRoot);
  const currentSnapshot = graphSnapshotIdentity(root).snapshotId;
  return matchingProjectionRun(candidates, currentSnapshot);
}

function projectionCandidates(runsRoot) {
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasProjectionManifest(runsRoot, entry.name))
    .map((entry) => projectionCandidate(runsRoot, entry.name))
    .sort(compareProjectionCandidates);
}

function hasProjectionManifest(runsRoot, runId) {
  return existsSync(resolve(runsRoot, runId, "graph", "manifest.json"));
}

function projectionCandidate(runsRoot, runId) {
  return {
    id: runId,
    manifest: readJson(resolve(runsRoot, runId, "graph", "manifest.json")),
  };
}

function compareProjectionCandidates(left, right) {
  return (
    String(right.manifest.transaction_time).localeCompare(String(left.manifest.transaction_time)) ||
    left.id.localeCompare(right.id)
  );
}

function matchingProjectionRun(candidates, snapshotId) {
  return (
    candidates.find((item) => item.manifest.snapshot_id === snapshotId)?.id ??
    candidates[0]?.id ??
    null
  );
}

function sourceSnippet(root, node) {
  if (node.source_ref.startsWith("git:") || credentialLike(node.source_ref)) return "";
  if (node.source_ref.includes("/agent-outputs/") || node.source_ref.endsWith(".events.jsonl"))
    return canonicalJson(node.attributes).slice(0, 2000);
  const absolute = resolve(root, node.source_ref);
  if (!safeRegularFile(absolute, root)) return "";
  return readFileSync(absolute, "utf8").slice(0, 2000);
}

export function tokens(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .match(/[a-z0-9_./-]{2,}/g) ?? [],
  );
}

export function queryGraph({
  projectRoot,
  runId,
  seed,
  phase = "query",
  maxDepth = 4,
  maxRecords = 200,
  includeModelProposed = false,
}) {
  validateGraphQuery(seed, maxDepth, maxRecords);
  const graph = loadGraph(projectRoot, runId);
  const allowed = queryTrustClasses(includeModelProposed);
  const nodes = currentQueryNodes(graph, allowed);
  const nodeSearchText = createNodeSearchText(graph);
  const adjacency = graphAdjacency(graph.edges, nodes, allowed);
  const seedTokens = tokens(seed);
  const exactSeeds = querySeeds(nodes, nodeSearchText, seed, seedTokens);
  const distances = graphDistances(exactSeeds, adjacency, maxDepth);
  const ranked = rankedGraphNodes(nodes, nodeSearchText, seed, seedTokens, distances);
  const records = ranked.slice(0, maxRecords).map((entry) => graphQueryRecord(graph, seed, entry));
  const bundle = graphQueryBundle(graph, {
    seed,
    phase,
    maxDepth,
    maxRecords,
    includeModelProposed,
    records,
  });
  if (!graphContractValidators().context(bundle))
    throw new Error("graph context does not satisfy its contract");
  writeGraphQueryContext(graph.graphDir, phase, bundle);
  return bundle;
}

function validateGraphQuery(seed, maxDepth, maxRecords) {
  if (!seed) throw new Error("graph query requires --seed <kind:id>");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4)
    throw new Error("graph query depth must be between 0 and 4");
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200)
    throw new Error("graph query limit must be between 1 and 200");
}

function queryTrustClasses(includeModelProposed) {
  return new Set(
    includeModelProposed
      ? ["authoritative", "verified-derived", "model-proposed"]
      : ["authoritative", "verified-derived"],
  );
}

function currentQueryNodes(graph, allowed) {
  const currentSnapshot =
    graphSnapshotIdentity(graph.root).snapshotId === graph.manifest.snapshot_id;
  return new Map(
    graph.nodes
      .filter(
        (node) => allowed.has(node.trust_class) && queryNodeCurrent(graph, node, currentSnapshot),
      )
      .map((node) => [node.logical_id, node]),
  );
}

function queryNodeCurrent(graph, node, currentSnapshot) {
  return node.graph_family === "repository" ? currentSnapshot : sourceCurrent(graph.root, node);
}

function createNodeSearchText(graph) {
  const searchText = new Map();
  return (node) => {
    if (!searchText.has(node.logical_id))
      searchText.set(node.logical_id, serializedNodeSearchText(graph, node));
    return searchText.get(node.logical_id);
  };
}

function serializedNodeSearchText(graph, node) {
  const snippet = node.kind === "File" ? sourceSnippet(graph.root, node) : "";
  return `${node.logical_id} ${canonicalJson(node.attributes)} ${snippet}`;
}

function graphAdjacency(edges, nodes, allowed) {
  const adjacency = new Map();
  for (const edge of edges.filter((item) => allowed.has(item.trust_class))) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    addAdjacentNode(adjacency, edge.from, edge.to);
    addAdjacentNode(adjacency, edge.to, edge.from);
  }
  return adjacency;
}

function addAdjacentNode(adjacency, from, to) {
  adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
}

function querySeeds(nodes, nodeSearchText, seed, seedTokens) {
  const exactSeeds = [...nodes.keys()].filter(
    (id) => id === seed || id.toLowerCase().includes(seed.toLowerCase()),
  );
  if (!exactSeeds.length)
    exactSeeds.push(...lexicalSeedCandidates(nodes, nodeSearchText, seedTokens));
  return exactSeeds;
}

function lexicalSeedCandidates(nodes, nodeSearchText, seedTokens) {
  return [...nodes.values()]
    .map((node) => ({
      id: node.logical_id,
      overlap: tokenOverlap(seedTokens, tokens(nodeSearchText(node))),
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((entry) => entry.id);
}

function graphDistances(seeds, adjacency, maxDepth) {
  const distances = new Map(seeds.map((id) => [id, 0]));
  let frontier = seeds;
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    frontier = nextGraphFrontier(frontier, adjacency, distances, depth);
  }
  return distances;
}

function nextGraphFrontier(frontier, adjacency, distances, depth) {
  const next = [];
  for (const id of frontier)
    for (const neighbor of adjacency.get(id) ?? [])
      if (!distances.has(neighbor)) {
        distances.set(neighbor, depth);
        next.push(neighbor);
      }
  return next;
}

function rankedGraphNodes(nodes, nodeSearchText, seed, seedTokens, distances) {
  return [...nodes.values()]
    .map((node) => graphNodeRank(node, nodeSearchText, seed, seedTokens, distances))
    .filter((entry) => entry.total > 0)
    .sort(
      (left, right) =>
        right.total - left.total || left.node.logical_id.localeCompare(right.node.logical_id),
    );
}

function graphNodeRank(node, nodeSearchText, seed, seedTokens, distances) {
  const lexical = seedTokens.size
    ? tokenOverlap(seedTokens, tokens(nodeSearchText(node))) / seedTokens.size
    : 0;
  const exact =
    node.logical_id === seed
      ? 1
      : node.logical_id.toLowerCase().includes(seed.toLowerCase())
        ? 0.75
        : 0;
  const depth = distances.get(node.logical_id) ?? null;
  const distance = depth === null ? 0 : 1 / (1 + depth);
  return { node, total: exact * 100 + lexical * 10 + distance, exact, lexical, distance, depth };
}

function tokenOverlap(left, right) {
  return [...left].filter((token) => right.has(token)).length;
}

function graphQueryRecord(graph, seed, entry) {
  return {
    node_id: entry.node.logical_id,
    kind: entry.node.kind,
    selection_reason: querySelectionReason(entry),
    traversal_path: entry.depth === null ? [] : [seed, entry.node.logical_id].slice(0, 5),
    trust_class: entry.node.trust_class,
    source_ref: entry.node.source_ref,
    source_digest: entry.node.source_digest,
    staleness: "current",
    score: {
      exact: entry.exact,
      lexical: entry.lexical,
      distance: entry.distance,
      total: entry.total,
    },
    snippet: sourceSnippet(graph.root, entry.node),
  };
}

function querySelectionReason(entry) {
  if (entry.exact) return "exact path or identifier match";
  return entry.depth !== null ? "bounded graph traversal" : "lexical match";
}

function graphQueryBundle(graph, options) {
  const { seed, phase, maxDepth, maxRecords, records } = options;
  return {
    schema_version: "1.0.0",
    repository_id: graph.manifest.repository_id,
    snapshot_id: graph.manifest.snapshot_id,
    run_id: graph.runId,
    phase,
    query_id: graphQueryId(graph.manifest.snapshot_id, options),
    seed,
    generated_at: graph.manifest.transaction_time,
    limits: { max_depth: maxDepth, max_records: maxRecords },
    records,
  };
}

function graphQueryId(snapshot, { seed, phase, maxDepth, maxRecords, includeModelProposed }) {
  return sha256(
    canonicalJson({ seed, phase, maxDepth, maxRecords, includeModelProposed, snapshot }),
  );
}

function writeGraphQueryContext(graphDir, phase, bundle) {
  const contextPath = resolve(graphDir, "contexts", `${phase.replace(/[^a-z0-9-]/gi, "-")}.json`);
  atomicWrite(contextPath, `${JSON.stringify(bundle, null, 2)}\n`);
}

export function sourceCurrent(root, node) {
  try {
    return (
      node.source_ref.startsWith("git:") ||
      sourceDigest(root, node.source_ref) === node.source_digest
    );
  } catch {
    return false;
  }
}

export function graphStatus({ projectRoot, runId }) {
  try {
    const graph = loadGraph(projectRoot, runId);
    const stale = graph.nodes.filter((node) => !sourceCurrent(graph.root, node)).length;
    return {
      available: true,
      repository_id: graph.manifest.repository_id,
      snapshot_id: graph.manifest.snapshot_id,
      run_id: graph.runId,
      canonical_digest: graph.manifest.canonical_digest,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      stale_sources: stale,
      unresolved_conflicts: 0,
      valid: stale === 0,
    };
  } catch (error) {
    return {
      available: false,
      valid: false,
      error: error.message,
      stale_sources: 0,
      unresolved_conflicts: 0,
    };
  }
}

export function explainGraphNode({ projectRoot, runId, nodeId }) {
  const graph = loadGraph(projectRoot, runId);
  const node = graph.nodes.find((item) => item.logical_id === nodeId || item.version_id === nodeId);
  if (!node) throw new Error(`graph node not found: ${nodeId}`);
  const edges = graph.edges.filter(
    (edge) => edge.from === node.logical_id || edge.to === node.logical_id,
  );
  return {
    node,
    current: sourceCurrent(graph.root, node),
    relationships: edges,
    source_snippet: sourceSnippet(graph.root, node),
  };
}
