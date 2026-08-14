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
} from "./core.mjs";
import { planOwnedPaths, projectRepository, trackedFiles } from "./repository.mjs";
import { projectRunEvidence } from "./artifacts.mjs";
import { validateGraph } from "./validation.mjs";

function graphSource(root, repositoryId, runId, runDir) {
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

function selectedGraphRun(runId, statePath, snapshotId) {
  const state = existsSync(statePath) ? readJson(statePath) : null;
  return runId ?? state?.run_id ?? `repository-${snapshotId.slice(0, 16)}`;
}

function graphProjectionContext(root, runId, identity, snapshot) {
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

function graphManifest(graph, root, identity, snapshot, selectedRun, source) {
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

function writeGraphProjection(outputDir, nodesBody, edgesBody, manifest) {
  mkdirSync(resolve(outputDir, "contexts"), { recursive: true, mode: 0o700 });
  atomicWrite(resolve(outputDir, "nodes.jsonl"), nodesBody);
  atomicWrite(resolve(outputDir, "edges.jsonl"), edgesBody);
  atomicWrite(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function projectGraph({ projectRoot, runId = null }) {
  const root = resolve(projectRoot);
  const identity = graphRepositoryIdentity(root);
  const snapshot = graphSnapshotIdentity(root);
  const { selectedRun, runDir, hasRun, outputDir, source } = graphProjectionContext(
    root,
    runId,
    identity,
    snapshot,
  );
  const graph = { nodes: [], edges: [] };
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
