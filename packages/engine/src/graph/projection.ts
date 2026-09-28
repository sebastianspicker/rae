/** Builds and persists canonical local graph projection files. */
import { existsSync, mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  GRAPH_LIMITS,
  GRAPH_PROJECTOR,
  atomicWrite,
  canonicalJson,
  graphRepositoryIdentity,
  graphRunPaths,
  graphSnapshotIdentity,
  graphContractValidators,
  jsonl,
  readJson,
  sha256,
  sourceDigest,
  transactionTime,
} from "./core.js";
import type { GraphBuilder, GraphSource } from "./core.js";
import { planOwnedPaths, projectRepository, trackedFiles } from "./repository.js";
import { projectRunEvidence } from "./artifacts.js";
import { validateGraph } from "./validation.js";

type ProjectionSource = Omit<GraphSource, "family" | "trust">;
type RepositoryIdentity = ReturnType<typeof graphRepositoryIdentity>;
type SnapshotIdentity = ReturnType<typeof graphSnapshotIdentity>;

function graphSource(
  root: string,
  repositoryId: string,
  runId: string | null,
  runDir: string | null,
): ProjectionSource {
  const sourceRef =
    runDir && existsSync(resolve(runDir, "request.json"))
      ? relative(root, resolve(runDir, "request.json"))
      : "README.md";
  return {
    repositoryId,
    runId,
    sourceRef,
    sourceHash: sourceDigest(root, sourceRef),
    time: transactionTime(root, runDir),
  };
}

function selectedGraphRun(runId: string | null, statePath: string, snapshotId: string): string {
  const state = existsSync(statePath) ? readJson(statePath) : null;
  return (
    runId ??
    (typeof state?.run_id === "string" ? state.run_id : null) ??
    `repository-${snapshotId.slice(0, 16)}`
  );
}

function graphProjectionContext(
  root: string,
  runId: string | null,
  identity: RepositoryIdentity,
  snapshot: SnapshotIdentity,
): {
  selectedRun: string;
  runDir: string;
  hasRun: boolean;
  outputDir: string;
  source: ProjectionSource;
} {
  const statePath = resolve(root, ".pipeline", "pipeline-state.json");
  const selectedRun = selectedGraphRun(runId, statePath, snapshot.snapshotId);
  const { runDir, graphDir: outputDir } = graphRunPaths(root, selectedRun);
  const hasRun = existsSync(resolve(runDir, "request.json"));
  if (runId && !hasRun) throw new Error(`run not found: ${runId}`);
  const source = graphSource(
    root,
    identity.repositoryId,
    hasRun ? selectedRun : null,
    hasRun ? runDir : null,
  );
  return { selectedRun, runDir, hasRun, outputDir, source };
}

function graphManifest(
  graph: GraphBuilder,
  root: string,
  identity: RepositoryIdentity,
  snapshot: SnapshotIdentity,
  selectedRun: string,
  source: ProjectionSource,
): {
  manifest: Record<string, unknown>;
  nodesBody: string;
  edgesBody: string;
} {
  graph.nodes.sort(
    (a, b) => a.logical_id.localeCompare(b.logical_id) || a.version_id.localeCompare(b.version_id),
  );
  graph.edges.sort(
    (a, b) => a.logical_id.localeCompare(b.logical_id) || a.version_id.localeCompare(b.version_id),
  );
  const validation = validateGraph(graph.nodes, graph.edges, root);
  if (!validation.valid)
    throw new Error(`graph validation failed: ${validation.issues.join("; ")}`);
  const nodesBody = jsonl(graph.nodes);
  const edgesBody = jsonl(graph.edges);
  const manifestCore = {
    schema_version: "1.0.0",
    projector: GRAPH_PROJECTOR,
    repository_id: identity.repositoryId,
    snapshot_id: snapshot.snapshotId,
    run_id: selectedRun,
    transaction_time: source.time,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    nodes_digest: sha256(nodesBody),
    edges_digest: sha256(edgesBody),
    limits: {
      max_nodes: GRAPH_LIMITS.maxNodes,
      max_edges: GRAPH_LIMITS.maxEdges,
      max_file_bytes: GRAPH_LIMITS.maxFileBytes,
    },
    validation,
  };
  const manifest = { ...manifestCore, canonical_digest: sha256(canonicalJson(manifestCore)) };
  if (!graphContractValidators().manifest(manifest))
    throw new Error("graph manifest does not satisfy its contract");
  return { manifest, nodesBody, edgesBody };
}

function writeGraphProjection(
  outputDir: string,
  nodesBody: string,
  edgesBody: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(resolve(outputDir, "contexts"), { recursive: true, mode: 0o700 });
  atomicWrite(resolve(outputDir, "nodes.jsonl"), nodesBody);
  atomicWrite(resolve(outputDir, "edges.jsonl"), edgesBody);
  atomicWrite(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function projectGraph({
  projectRoot,
  runId = null,
}: {
  projectRoot: string;
  runId?: string | null;
}): Record<string, unknown> {
  const root = resolve(projectRoot);
  const identity = graphRepositoryIdentity(root);
  const snapshot = graphSnapshotIdentity(root);
  const { selectedRun, runDir, hasRun, outputDir, source } = graphProjectionContext(
    root,
    runId,
    identity,
    snapshot,
  );
  const graph: GraphBuilder = { nodes: [], edges: [] };
  const files = trackedFiles(root, hasRun ? planOwnedPaths(runDir) : []);
  const { repoNode } = projectRepository(graph, root, source, files, snapshot.snapshotId);
  if (hasRun) projectRunEvidence(graph, root, runDir, selectedRun, source, repoNode);
  const { manifest, nodesBody, edgesBody } = graphManifest(
    graph,
    root,
    identity,
    snapshot,
    selectedRun,
    source,
  );
  writeGraphProjection(outputDir, nodesBody, edgesBody, manifest);
  return { ...manifest, graph_dir: relative(root, outputDir) };
}
