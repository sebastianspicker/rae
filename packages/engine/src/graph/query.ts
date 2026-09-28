/** Loads, queries, reports on, and explains persisted graph projections. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  GraphGraphContext,
  GraphGraphEdge,
  GraphGraphManifest,
  GraphGraphNode,
} from "@rae/contracts";
import {
  atomicWrite,
  cachedSourceDigest,
  canonicalJson,
  credentialLike,
  graphContractValidators,
  graphRunPaths,
  graphRepositoryIdentity,
  graphSnapshotIdentity,
  readJson,
  readUtf8FilePrefix,
  safeRegularFile,
  sha256,
} from "./core.js";
import { validateGraph } from "./validation.js";

export function readJsonl<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("record is not an object");
        }
        return parsed as T;
      } catch {
        throw new Error(`corrupt JSONL at ${path}:${index + 1}`);
      }
    });
}

const MAX_PARSED_GRAPH_CACHE_ENTRIES = 8;
const MAX_PARSED_GRAPH_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_PARSED_GRAPH_CACHE_BYTES = 32 * 1024 * 1024;
const PARSED_RECORD_OVERHEAD_BYTES = 192;
const CACHED_STRING_OVERHEAD_BYTES = 48;
const CACHED_ADJACENCY_ENTRY_BYTES = 64;

interface ParsedGraph {
  nodes: readonly GraphGraphNode[];
  edges: readonly GraphGraphEdge[];
  adjacencyByTrust: Map<string, Map<string, string[]>>;
  lexicalBaseByNode: ReadonlyMap<string, string>;
  estimatedBytes: number;
  retained: boolean;
}

interface LoadedGraph {
  root: string;
  runId: string;
  graphDir: string;
  manifest: GraphGraphManifest;
  nodes: readonly GraphGraphNode[];
  edges: readonly GraphGraphEdge[];
}

interface GraphOperation {
  parsed: ParsedGraph;
  adjacencyByTrust: ParsedGraph["adjacencyByTrust"];
  lexicalBaseByNode: ParsedGraph["lexicalBaseByNode"];
  digestCache: Map<string, string>;
  snippetCache: Map<string, string>;
  searchTextByNode: Map<string, string>;
  snapshotId: string;
  currentByNode: Map<string, boolean>;
}

type NodeSearchText = (node: GraphGraphNode) => string;
interface RankedNode {
  node: GraphGraphNode;
  total: number;
  exact: number;
  lexical: number;
  distance: number;
  depth: number | null;
}

const parsedGraphCache = new Map<string, ParsedGraph>();
const graphOperations = new WeakMap<LoadedGraph, GraphOperation>();
const cacheMetrics = {
  adjacency_builds: 0,
  adjacency_reuses: 0,
  cache_bypasses: 0,
  content_read_bytes: 0,
  content_digest_checks: 0,
  parse_duration_ms: 0,
  parsed_loads: 0,
  parsed_reuses: 0,
  lexical_builds: 0,
  lexical_reuses: 0,
  lexical_bypasses: 0,
  source_digest_reads: 0,
};

/** Exposes operation counts for deterministic benchmarks without timing thresholds. */
export function graphCacheDiagnostics({ reset = false } = {}) {
  const result = {
    ...cacheMetrics,
    cache_entries: parsedGraphCache.size,
    cache_bytes: cachedGraphBytes(),
    max_entry_bytes: MAX_PARSED_GRAPH_CACHE_ENTRY_BYTES,
    max_total_bytes: MAX_PARSED_GRAPH_CACHE_BYTES,
  };
  if (reset) {
    for (const key of Object.keys(cacheMetrics) as Array<keyof typeof cacheMetrics>)
      cacheMetrics[key] = 0;
    parsedGraphCache.clear();
  }
  return result;
}

function touchParsedGraph(key: string, value: ParsedGraph): ParsedGraph {
  parsedGraphCache.delete(key);
  parsedGraphCache.set(key, value);
  while (
    parsedGraphCache.size > MAX_PARSED_GRAPH_CACHE_ENTRIES ||
    cachedGraphBytes() > MAX_PARSED_GRAPH_CACHE_BYTES
  ) {
    const oldest = parsedGraphCache.keys().next().value;
    if (oldest !== undefined) parsedGraphCache.delete(oldest);
  }
  return value;
}

function cachedGraphBytes(): number {
  return [...parsedGraphCache.values()].reduce((total, entry) => total + entry.estimatedBytes, 0);
}

export function loadGraph(projectRoot: string, runId?: string | null): LoadedGraph {
  const root = resolve(projectRoot);
  const identity = graphRepositoryIdentity(root);
  const selectedRun = selectedGraphRun(root, runId);
  if (!selectedRun) throw new Error("--run-id is required when no active pipeline state exists");
  const { graphDir } = graphRunPaths(root, selectedRun);
  const manifest = loadGraphManifest(graphDir, selectedRun, identity.repositoryId);
  const parsed = loadGraphRecords(graphDir, manifest, identity.repositoryId);
  const { nodes, edges, adjacencyByTrust, lexicalBaseByNode } = parsed;
  validateManifestRecordCounts(manifest, nodes, edges);
  validateLoadedGraph(nodes, edges, root);
  const graph = { root, runId: selectedRun, graphDir, manifest, nodes, edges };
  const operation: GraphOperation = {
    parsed,
    adjacencyByTrust,
    lexicalBaseByNode,
    digestCache: new Map(),
    snippetCache: new Map(),
    searchTextByNode: new Map(),
    snapshotId: graphSnapshotIdentity(root).snapshotId,
    currentByNode: new Map(),
  };
  verifyGraphFreshness(graph, operation);
  graphOperations.set(graph, operation);
  return graph;
}

function verifyGraphFreshness(graph: LoadedGraph, operation: GraphOperation): void {
  const snapshotCurrent = operation.snapshotId === graph.manifest.snapshot_id;
  for (const node of graph.nodes) {
    operation.currentByNode.set(
      node.logical_id,
      node.graph_family === "repository"
        ? snapshotCurrent
        : sourceCurrent(graph.root, node, operation.digestCache),
    );
  }
  cacheMetrics.source_digest_reads += operation.digestCache.size;
}

function selectedGraphRun(root: string, runId?: string | null): string | null {
  if (runId) return runId;
  const statePath = resolve(root, ".pipeline", "pipeline-state.json");
  if (!existsSync(statePath)) return discoverProjectionRun(root);
  const state = readJson(statePath) as { run_id?: unknown };
  return typeof state.run_id === "string" ? state.run_id : null;
}

function loadGraphManifest(
  graphDir: string,
  selectedRun: string,
  repositoryId: string,
): GraphGraphManifest {
  const manifestPath = resolve(graphDir, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error(`graph projection not found for run: ${selectedRun}`);
  const manifest = readJson(manifestPath) as GraphGraphManifest;
  validateLoadedManifest(manifest, selectedRun, repositoryId);
  return manifest;
}

function loadGraphRecords(
  graphDir: string,
  manifest: GraphGraphManifest,
  repositoryId: string,
): ParsedGraph {
  const nodesBody = readFileSync(resolve(graphDir, "nodes.jsonl"));
  const edgesBody = readFileSync(resolve(graphDir, "edges.jsonl"));
  cacheMetrics.content_read_bytes += nodesBody.length + edgesBody.length;
  const nodesDigest = sha256(nodesBody);
  const edgesDigest = sha256(edgesBody);
  cacheMetrics.content_digest_checks += 2;
  if (nodesDigest !== manifest.nodes_digest || edgesDigest !== manifest.edges_digest) {
    throw new Error("graph projection digest mismatch");
  }
  const key = `${repositoryId}\0${manifest.run_id}\0${manifest.canonical_digest}\0${nodesDigest}\0${edgesDigest}`;
  const cached = parsedGraphCache.get(key);
  if (cached) {
    cacheMetrics.parsed_reuses++;
    return touchParsedGraph(key, cached);
  }
  const parseStarted = performance.now();
  const nodes = parseJsonlBody<GraphGraphNode>(nodesBody, resolve(graphDir, "nodes.jsonl"));
  const edges = parseJsonlBody<GraphGraphEdge>(edgesBody, resolve(graphDir, "edges.jsonl"));
  cacheMetrics.parse_duration_ms += performance.now() - parseStarted;
  cacheMetrics.parsed_loads++;
  const estimatedBytes =
    nodesBody.length +
    edgesBody.length +
    (nodes.length + edges.length) * PARSED_RECORD_OVERHEAD_BYTES;
  const lexicalBaseByNode = new Map<string, string>();
  let lexicalBytes = 0;
  for (const node of nodes) {
    const text = `${node.logical_id} ${canonicalJson(node.attributes)}`;
    lexicalBaseByNode.set(node.logical_id, text);
    lexicalBytes += Buffer.byteLength(text) + CACHED_STRING_OVERHEAD_BYTES;
  }
  cacheMetrics.lexical_builds++;
  const completeBytes = estimatedBytes + lexicalBytes;
  const parsed: ParsedGraph = {
    nodes,
    edges,
    adjacencyByTrust: new Map(),
    lexicalBaseByNode,
    estimatedBytes: completeBytes,
    retained: completeBytes <= MAX_PARSED_GRAPH_CACHE_ENTRY_BYTES,
  };
  if (!parsed.retained) {
    cacheMetrics.cache_bypasses++;
    cacheMetrics.lexical_bypasses++;
    return parsed;
  }
  return touchParsedGraph(key, parsed);
}

function parseJsonlBody<T extends GraphGraphNode | GraphGraphEdge>(
  body: Buffer,
  path: string,
): readonly T[] {
  return Object.freeze(
    body
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return deepFreeze(JSON.parse(line)) as T;
        } catch {
          throw new Error(`corrupt JSONL at ${path}:${index + 1}`);
        }
      }),
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function validateLoadedGraph(
  nodes: readonly GraphGraphNode[],
  edges: readonly GraphGraphEdge[],
  root: string,
): void {
  const validation = validateGraph(nodes, edges, root, { verifySources: false });
  if (!validation.valid)
    throw new Error(`graph validation failed: ${validation.issues.join("; ")}`);
}

function validateLoadedManifest(
  manifest: GraphGraphManifest,
  selectedRun: string,
  repositoryId: string,
): void {
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

function validateManifestRecordCounts(
  manifest: GraphGraphManifest,
  nodes: readonly GraphGraphNode[],
  edges: readonly GraphGraphEdge[],
): void {
  if (manifest.node_count !== nodes.length || manifest.edge_count !== edges.length) {
    throw new Error("graph manifest record count mismatch");
  }
}

function discoverProjectionRun(root: string): string | null {
  const runsRoot = resolve(root, ".pipeline", "runs");
  if (!existsSync(runsRoot)) return null;
  const candidates = projectionCandidates(runsRoot);
  const currentSnapshot = graphSnapshotIdentity(root).snapshotId;
  return matchingProjectionRun(candidates, currentSnapshot);
}

function projectionCandidates(
  runsRoot: string,
): Array<{ id: string; manifest: GraphGraphManifest }> {
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasProjectionManifest(runsRoot, entry.name))
    .map((entry) => projectionCandidate(runsRoot, entry.name))
    .sort(compareProjectionCandidates);
}

function hasProjectionManifest(runsRoot: string, runId: string): boolean {
  return existsSync(resolve(runsRoot, runId, "graph", "manifest.json"));
}

function projectionCandidate(
  runsRoot: string,
  runId: string,
): { id: string; manifest: GraphGraphManifest } {
  return {
    id: runId,
    manifest: readJson(resolve(runsRoot, runId, "graph", "manifest.json")) as GraphGraphManifest,
  };
}

function compareProjectionCandidates(
  left: { id: string; manifest: GraphGraphManifest },
  right: { id: string; manifest: GraphGraphManifest },
): number {
  return (
    String(right.manifest.transaction_time).localeCompare(String(left.manifest.transaction_time)) ||
    left.id.localeCompare(right.id)
  );
}

function matchingProjectionRun(
  candidates: Array<{ id: string; manifest: GraphGraphManifest }>,
  snapshotId: string,
): string | null {
  return (
    candidates.find((item) => item.manifest.snapshot_id === snapshotId)?.id ??
    candidates[0]?.id ??
    null
  );
}

function sourceSnippet(root: string, node: GraphGraphNode, operation: GraphOperation): string {
  if (node.source_ref.startsWith("git:") || credentialLike(node.source_ref)) return "";
  if (node.source_ref.includes("/agent-outputs/") || node.source_ref.endsWith(".events.jsonl"))
    return canonicalJson(node.attributes).slice(0, 2000);
  const absolute = resolve(root, node.source_ref);
  if (!safeRegularFile(absolute, root)) return "";
  if (!operation?.snippetCache.has(node.source_ref)) {
    operation?.snippetCache.set(node.source_ref, readUtf8FilePrefix(absolute, 2000));
  }
  return operation?.snippetCache.get(node.source_ref) ?? readUtf8FilePrefix(absolute, 2000);
}

export function tokens(value: unknown): Set<string> {
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
}: {
  projectRoot: string;
  runId?: string | null;
  seed: string;
  phase?: string;
  maxDepth?: number;
  maxRecords?: number;
  includeModelProposed?: boolean;
}) {
  validateGraphQuery(seed, maxDepth, maxRecords);
  const graph = loadGraph(projectRoot, runId);
  const operation = graphOperations.get(graph)!;
  const allowed = queryTrustClasses(includeModelProposed);
  const nodes = currentQueryNodes(graph, allowed, operation);
  const nodeSearchText = createNodeSearchText(graph, operation);
  const adjacency = graphAdjacency(graph.edges, nodes, allowed, operation);
  const seedTokens = tokens(seed);
  const exactSeeds = querySeeds(nodes, nodeSearchText, seed, seedTokens);
  const distances = graphDistances(exactSeeds, adjacency, maxDepth);
  const ranked = rankedGraphNodes(nodes, nodeSearchText, seed, seedTokens, distances);
  const records = ranked
    .slice(0, maxRecords)
    .map((entry) => graphQueryRecord(graph, seed, entry, operation));
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

function validateGraphQuery(seed: string, maxDepth: number, maxRecords: number): void {
  if (!seed) throw new Error("graph query requires --seed <kind:id>");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4)
    throw new Error("graph query depth must be between 0 and 4");
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200)
    throw new Error("graph query limit must be between 1 and 200");
}

type TrustClass = GraphGraphNode["trust_class"];

function queryTrustClasses(includeModelProposed: boolean): Set<TrustClass> {
  return new Set<TrustClass>(
    includeModelProposed
      ? ["authoritative", "verified-derived", "model-proposed"]
      : ["authoritative", "verified-derived"],
  );
}

function currentQueryNodes(
  graph: LoadedGraph,
  allowed: Set<TrustClass>,
  operation: GraphOperation,
): Map<string, GraphGraphNode> {
  const currentSnapshot = operation.snapshotId === graph.manifest.snapshot_id;
  return new Map(
    graph.nodes
      .filter(
        (node) =>
          allowed.has(node.trust_class) && queryNodeCurrent(node, currentSnapshot, operation),
      )
      .map((node) => [node.logical_id, node]),
  );
}

function queryNodeCurrent(
  node: GraphGraphNode,
  currentSnapshot: boolean,
  operation: GraphOperation,
): boolean {
  return operation.currentByNode.get(node.logical_id) ?? currentSnapshot;
}

function createNodeSearchText(
  graph: LoadedGraph,
  operation: GraphOperation,
): (node: GraphGraphNode) => string {
  return (node: GraphGraphNode): string => {
    const cached = operation.searchTextByNode.get(node.logical_id);
    if (cached !== undefined) {
      cacheMetrics.lexical_reuses++;
      return cached;
    }
    const text = serializedNodeSearchText(graph, node, operation);
    operation.searchTextByNode.set(node.logical_id, text);
    return text;
  };
}

function serializedNodeSearchText(
  graph: LoadedGraph,
  node: GraphGraphNode,
  operation: GraphOperation,
): string {
  const snippet = node.kind === "File" ? sourceSnippet(graph.root, node, operation) : "";
  const cachedBase = operation.lexicalBaseByNode.get(node.logical_id);
  if (cachedBase !== undefined) cacheMetrics.lexical_reuses++;
  const base = cachedBase ?? `${node.logical_id} ${canonicalJson(node.attributes)}`;
  return `${base} ${snippet}`;
}

function graphAdjacency(
  edges: readonly GraphGraphEdge[],
  nodes: Map<string, GraphGraphNode>,
  allowed: Set<TrustClass>,
  operation: GraphOperation,
): Map<string, string[]> {
  const trustKey = [...allowed].sort().join("\0");
  let complete = operation.adjacencyByTrust.get(trustKey);
  if (!complete) {
    cacheMetrics.adjacency_builds++;
    complete = new Map<string, string[]>();
    for (const edge of edges) {
      if (!allowed.has(edge.trust_class)) continue;
      addAdjacentNode(complete, edge.from, edge.to);
      addAdjacentNode(complete, edge.to, edge.from);
    }
    const adjacencyBytes = estimateAdjacencyBytes(complete);
    if (
      operation.parsed.retained &&
      operation.parsed.estimatedBytes + adjacencyBytes <= MAX_PARSED_GRAPH_CACHE_ENTRY_BYTES
    ) {
      operation.parsed.estimatedBytes += adjacencyBytes;
      operation.adjacencyByTrust.set(trustKey, complete);
      // Re-apply the byte-bounded LRU after growing an already retained entry.
      const cacheEntry = [...parsedGraphCache.entries()].find(
        ([, value]) => value === operation.parsed,
      );
      if (cacheEntry) touchParsedGraph(cacheEntry[0], operation.parsed);
    } else {
      cacheMetrics.cache_bypasses++;
    }
  } else {
    cacheMetrics.adjacency_reuses++;
  }
  const adjacency = new Map<string, string[]>();
  for (const [from, neighbors] of complete) {
    if (!nodes.has(from)) continue;
    const current = neighbors.filter((to) => nodes.has(to));
    if (current.length) adjacency.set(from, current);
  }
  return adjacency;
}

function estimateAdjacencyBytes(adjacency: Map<string, string[]>): number {
  let bytes = 0;
  for (const [from, neighbors] of adjacency) {
    bytes += Buffer.byteLength(from) + CACHED_ADJACENCY_ENTRY_BYTES;
    for (const neighbor of neighbors) bytes += Buffer.byteLength(neighbor) + 8;
  }
  return bytes;
}

function addAdjacentNode(adjacency: Map<string, string[]>, from: string, to: string): void {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from)!.push(to);
}

function querySeeds(
  nodes: Map<string, GraphGraphNode>,
  nodeSearchText: NodeSearchText,
  seed: string,
  seedTokens: Set<string>,
): string[] {
  const exactSeeds = [...nodes.keys()].filter(
    (id) => id === seed || id.toLowerCase().includes(seed.toLowerCase()),
  );
  if (!exactSeeds.length)
    exactSeeds.push(...lexicalSeedCandidates(nodes, nodeSearchText, seedTokens));
  return exactSeeds;
}

function lexicalSeedCandidates(
  nodes: Map<string, GraphGraphNode>,
  nodeSearchText: NodeSearchText,
  seedTokens: Set<string>,
): string[] {
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

function graphDistances(
  seeds: string[],
  adjacency: Map<string, string[]>,
  maxDepth: number,
): Map<string, number> {
  const distances = new Map(seeds.map((id) => [id, 0]));
  let frontier = seeds;
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    frontier = nextGraphFrontier(frontier, adjacency, distances, depth);
  }
  return distances;
}

function nextGraphFrontier(
  frontier: string[],
  adjacency: Map<string, string[]>,
  distances: Map<string, number>,
  depth: number,
): string[] {
  const next: string[] = [];
  for (const id of frontier)
    for (const neighbor of adjacency.get(id) ?? [])
      if (!distances.has(neighbor)) {
        distances.set(neighbor, depth);
        next.push(neighbor);
      }
  return next;
}

function rankedGraphNodes(
  nodes: Map<string, GraphGraphNode>,
  nodeSearchText: NodeSearchText,
  seed: string,
  seedTokens: Set<string>,
  distances: Map<string, number>,
): RankedNode[] {
  return [...nodes.values()]
    .map((node) => graphNodeRank(node, nodeSearchText, seed, seedTokens, distances))
    .filter((entry) => entry.total > 0)
    .sort(
      (left, right) =>
        right.total - left.total || left.node.logical_id.localeCompare(right.node.logical_id),
    );
}

function graphNodeRank(
  node: GraphGraphNode,
  nodeSearchText: NodeSearchText,
  seed: string,
  seedTokens: Set<string>,
  distances: Map<string, number>,
): RankedNode {
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

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  return [...left].filter((token) => right.has(token)).length;
}

function graphQueryRecord(
  graph: LoadedGraph,
  seed: string,
  entry: RankedNode,
  operation: GraphOperation,
): GraphGraphContext["records"][number] {
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
    snippet: sourceSnippet(graph.root, entry.node, operation),
  };
}

function querySelectionReason(entry: RankedNode): string {
  if (entry.exact) return "exact path or identifier match";
  return entry.depth !== null ? "bounded graph traversal" : "lexical match";
}

interface QueryBundleOptions {
  seed: string;
  phase: string;
  maxDepth: number;
  maxRecords: number;
  includeModelProposed: boolean;
  records: GraphGraphContext["records"];
}

function graphQueryBundle(graph: LoadedGraph, options: QueryBundleOptions): GraphGraphContext {
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

function graphQueryId(
  snapshot: string,
  { seed, phase, maxDepth, maxRecords, includeModelProposed }: Omit<QueryBundleOptions, "records">,
): string {
  return sha256(
    canonicalJson({ seed, phase, maxDepth, maxRecords, includeModelProposed, snapshot }),
  );
}

function writeGraphQueryContext(graphDir: string, phase: string, bundle: GraphGraphContext): void {
  const contextPath = resolve(graphDir, "contexts", `${phase.replace(/[^a-z0-9-]/gi, "-")}.json`);
  atomicWrite(contextPath, `${JSON.stringify(bundle, null, 2)}\n`);
}

export function sourceCurrent(
  root: string,
  node: { source_ref: string; source_digest: string },
  digestCache: Map<string, string> = new Map(),
): boolean {
  try {
    return (
      node.source_ref.startsWith("git:") ||
      cachedSourceDigest(root, node.source_ref, digestCache) === node.source_digest
    );
  } catch {
    return false;
  }
}

export function graphStatus({
  projectRoot,
  runId,
}: {
  projectRoot: string;
  runId?: string | null;
}) {
  try {
    const graph = loadGraph(projectRoot, runId);
    const operation = graphOperations.get(graph)!;
    const stale = graph.nodes.filter(
      (node) =>
        !queryNodeCurrent(node, operation.snapshotId === graph.manifest.snapshot_id, operation),
    ).length;
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
  } catch (error: unknown) {
    return {
      available: false,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
      stale_sources: 0,
      unresolved_conflicts: 0,
    };
  }
}

export function explainGraphNode({
  projectRoot,
  runId,
  nodeId,
}: {
  projectRoot: string;
  runId?: string | null;
  nodeId: string;
}) {
  const graph = loadGraph(projectRoot, runId);
  const operation = graphOperations.get(graph)!;
  const node = graph.nodes.find((item) => item.logical_id === nodeId || item.version_id === nodeId);
  if (!node) throw new Error(`graph node not found: ${nodeId}`);
  const edges = graph.edges.filter(
    (edge) => edge.from === node.logical_id || edge.to === node.logical_id,
  );
  return {
    node,
    current: queryNodeCurrent(node, operation.snapshotId === graph.manifest.snapshot_id, operation),
    relationships: edges,
    source_snippet: sourceSnippet(graph.root, node, operation),
  };
}
