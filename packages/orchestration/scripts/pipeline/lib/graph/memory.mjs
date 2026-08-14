/** Persists, curates, and retrieves repository-isolated graph memory. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  GRAPH_PROJECTOR,
  atomicWrite,
  canonicalJson,
  contained,
  credentialLike,
  graphContractValidators,
  graphRepositoryIdentity,
  jsonl,
  readJson,
  safeRegularFile,
  sha256,
} from "./core.mjs";
import { loadGraph, readJsonl, sourceCurrent, tokens } from "./query.mjs";

function memoryPaths(projectRoot) {
  const { commonDir, repositoryId } = graphRepositoryIdentity(projectRoot);
  const root = resolve(commonDir, "rae-memory", "v1");
  return {
    root,
    repositoryId,
    facts: resolve(root, "facts.jsonl"),
    candidates: resolve(root, "candidates.jsonl"),
    decisions: resolve(root, "decisions.jsonl"),
    sources: resolve(root, "sources"),
    lock: resolve(root, "memory.lock"),
  };
}

function memoryRecord(node, paths) {
  const evidence = canonicalJson({
    logical_id: node.logical_id,
    kind: node.kind,
    attributes: node.attributes,
    original_source_ref: node.source_ref,
    original_source_digest: node.source_digest,
  });
  const sourceBody = `${evidence}\n`;
  const digest = sha256(sourceBody);
  atomicWrite(resolve(paths.sources, `${digest}.json`), sourceBody);
  return {
    ...node,
    graph_family: "memory",
    source_ref: `memory:sources/${digest}.json`,
    source_digest: digest,
    version_id: sha256(`${node.kind}\0${node.logical_id}\0${digest}`),
    attributes: {
      ...node.attributes,
      original_source_ref: node.source_ref,
      original_source_digest: node.source_digest,
    },
  };
}

function memorySourceCurrent(paths, item) {
  if (!item.source_ref.startsWith("memory:sources/")) return sourceCurrent(paths.projectRoot, item);
  const name = item.source_ref.slice("memory:sources/".length);
  const path = resolve(paths.sources, name);
  try {
    return contained(path, paths.root) && sha256(readFileSync(path)) === item.source_digest;
  } catch {
    return false;
  }
}

function withMemoryLock(paths, operation) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = acquireMemoryLock(paths.lock);
  } catch {
    throw new Error("graph memory is locked by another process");
  }
  try {
    return operation();
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(paths.lock, { force: true });
  }
}

function acquireMemoryLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      return fd;
    } catch (error) {
      if (error.code !== "EEXIST" || !staleMemoryLock(lockPath) || attempt > 0) throw error;
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("unable to acquire graph memory lock");
}

function staleMemoryLock(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH" || error.code === "ENOENT";
  }
}

function appendJsonl(path, record) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWrite(path, `${existing}${canonicalJson(record)}\n`);
}

export function recordRunMemory({ projectRoot, runId }) {
  const runDir = resolve(projectRoot, ".pipeline", "runs", runId);
  validateCompletedMemoryRun(runDir);
  const graph = loadGraph(projectRoot, runId);
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  return withMemoryLock(paths, () => {
    const existing = deduplicatedByVersion(readJsonl(paths.facts));
    const candidates = new Map(readJsonl(paths.candidates).map((item) => [item.version_id, item]));
    const decisions = readJsonl(paths.decisions);
    invalidateStaleFacts(paths, existing, decisions);
    recordMemoryNodes(graph.nodes, projectRoot, paths, existing, candidates, decisions);
    writeMemoryRecords(paths, existing, candidates, decisions);
    return memoryStatus(projectRoot);
  });
}

function validateCompletedMemoryRun(runDir) {
  const controlPath = resolve(runDir, "operator-control.json");
  const tracePath = resolve(runDir, "trace.jsonl");
  const completedControl = existsSync(controlPath) && readJson(controlPath).status === "completed";
  const completedTrace =
    existsSync(tracePath) && readFileSync(tracePath, "utf8").includes('"event":"run_completed"');
  if (!completedControl || !completedTrace)
    throw new Error("graph memory imports only completed runs with durable completion evidence");
}

function invalidateStaleFacts(paths, existing, decisions) {
  for (const prior of existing) {
    if (
      memorySourceCurrent(paths, prior) ||
      hasDecision(decisions, prior.version_id, "invalidated")
    )
      continue;
    const recordedAt = new Date().toISOString();
    decisions.push({
      schema_version: "1.0.0",
      decision_id: sha256(`${prior.version_id}\0invalidated\0${recordedAt}`),
      candidate_id: prior.version_id,
      decision: "invalidated",
      actor: GRAPH_PROJECTOR,
      rationale: "cached source digest no longer resolves",
      source_ref: prior.source_ref,
      source_digest: prior.source_digest,
      recorded_at: recordedAt,
    });
  }
}

function recordMemoryNodes(nodes, projectRoot, paths, existing, candidates, decisions) {
  for (const node of nodes) {
    if (!sourceCurrent(projectRoot, node)) continue;
    const storedNode = memoryRecord(node, paths);
    if (memoryFact(storedNode)) recordMemoryFact(storedNode, existing, decisions);
    else if (storedNode.trust_class === "model-proposed")
      candidates.set(storedNode.version_id, { ...storedNode, trust_class: "untrusted" });
  }
}

function memoryFact(node) {
  return (
    ["GateDecision", "CheckpointDecision", "CommandExecution", "ProjectSnapshot"].includes(
      node.kind,
    ) && ["authoritative", "verified-derived"].includes(node.trust_class)
  );
}

function recordMemoryFact(storedNode, existing, decisions) {
  for (const prior of existing) {
    if (prior.logical_id !== storedNode.logical_id || prior.version_id === storedNode.version_id)
      continue;
    if (!hasDecision(decisions, prior.version_id, "superseded"))
      decisions.push(supersededDecision(prior, storedNode));
  }
  const index = existing.findIndex((item) => item.version_id === storedNode.version_id);
  if (index === -1) existing.push(storedNode);
  else existing[index] = storedNode;
}

function deduplicatedByVersion(records) {
  const unique = [];
  for (const record of records) {
    const index = unique.findIndex((item) => item.version_id === record.version_id);
    if (index === -1) unique.push(record);
    else unique[index] = record;
  }
  return unique;
}

function hasDecision(decisions, candidateId, decision) {
  return decisions.some((item) => item.candidate_id === candidateId && item.decision === decision);
}

function supersededDecision(prior, storedNode) {
  return {
    schema_version: "1.0.0",
    decision_id: sha256(`${prior.version_id}\0superseded\0${storedNode.version_id}`),
    candidate_id: prior.version_id,
    decision: "superseded",
    actor: GRAPH_PROJECTOR,
    rationale: `superseded by ${storedNode.version_id}`,
    source_ref: storedNode.source_ref,
    source_digest: storedNode.source_digest,
    recorded_at: storedNode.transaction_time,
  };
}

function writeMemoryRecords(paths, existing, candidates, decisions) {
  atomicWrite(paths.facts, jsonl(sortedByVersion(existing)));
  atomicWrite(paths.candidates, jsonl(sortedByVersion(candidates)));
  atomicWrite(paths.decisions, jsonl(validatedDecisions(decisions)));
}

function sortedByVersion(records) {
  const items = Array.isArray(records) ? records : records.values();
  return [...items].sort((a, b) => a.version_id.localeCompare(b.version_id));
}

function validatedDecisions(decisions) {
  return decisions
    .map((decision) => {
      if (!graphContractValidators().decision(decision))
        throw new Error("graph memory decision does not satisfy its contract");
      return decision;
    })
    .sort(
      (a, b) =>
        a.recorded_at.localeCompare(b.recorded_at) || a.decision_id.localeCompare(b.decision_id),
    );
}

export function memoryStatus(projectRoot) {
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  const facts = readJsonl(paths.facts);
  const candidates = readJsonl(paths.candidates);
  const decisions = readJsonl(paths.decisions);
  const decided = new Set(decisions.map((item) => item.candidate_id));
  const staleFacts = facts.filter((item) => !memorySourceCurrent(paths, item)).length;
  const superseded = new Set(
    decisions
      .filter((item) => ["superseded", "invalidated", "rejected"].includes(item.decision))
      .map((item) => item.candidate_id),
  );
  const currentFacts = facts.filter(
    (item) => memorySourceCurrent(paths, item) && !superseded.has(item.version_id),
  );
  const logicalCounts = new Map();
  for (const item of currentFacts)
    logicalCounts.set(item.logical_id, (logicalCounts.get(item.logical_id) ?? 0) + 1);
  return {
    repository_id: paths.repositoryId,
    facts: facts.length,
    candidates: candidates.length,
    pending_candidates: candidates.filter((item) => !decided.has(item.version_id)).length,
    decisions: decisions.length,
    stale_facts: staleFacts,
    unresolved_conflicts: [...logicalCounts.values()].filter((count) => count > 1).length,
    memory_dir: paths.root,
  };
}

export function listMemory({ projectRoot, status = "all" }) {
  const paths = memoryPaths(projectRoot);
  const facts = readJsonl(paths.facts);
  const candidates = readJsonl(paths.candidates);
  const decisions = readJsonl(paths.decisions);
  if (status === "facts") return { status: memoryStatus(projectRoot), records: facts, decisions };
  if (status === "candidates")
    return { status: memoryStatus(projectRoot), records: candidates, decisions };
  return { status: memoryStatus(projectRoot), facts, candidates, decisions };
}

export function decideMemory({ projectRoot, candidateId, decision, actor, rationale, sourceRef }) {
  for (const [label, value] of Object.entries({ candidateId, actor, rationale, sourceRef }))
    if (!value) throw new Error(`memory ${decision} requires ${label}`);
  const paths = memoryPaths(projectRoot);
  if (isAbsolute(sourceRef) || sourceRef.includes("\0"))
    throw new Error("corroborating source must be repository-relative");
  const absolute = resolve(projectRoot, sourceRef);
  if (!safeRegularFile(absolute, projectRoot) || credentialLike(sourceRef))
    throw new Error("corroborating source must be a safe repository-relative regular file");
  return withMemoryLock(paths, () => {
    const candidate = readJsonl(paths.candidates).find((item) => item.version_id === candidateId);
    if (!candidate) throw new Error(`memory candidate not found: ${candidateId}`);
    const recordedAt = new Date().toISOString();
    const record = {
      schema_version: "1.0.0",
      decision_id: sha256(`${candidateId}\0${decision}\0${actor}\0${recordedAt}`),
      candidate_id: candidateId,
      decision,
      actor,
      rationale,
      source_ref: sourceRef,
      source_digest: sha256(readFileSync(absolute)),
      recorded_at: recordedAt,
    };
    if (!graphContractValidators().decision(record))
      throw new Error("graph memory decision does not satisfy its contract");
    appendJsonl(paths.decisions, record);
    if (decision === "promoted") {
      const facts = new Map(readJsonl(paths.facts).map((item) => [item.version_id, item]));
      const promotedVersion = sha256(
        `${candidate.kind}\0${candidate.logical_id}\0${record.source_digest}`,
      );
      facts.set(promotedVersion, {
        ...candidate,
        version_id: promotedVersion,
        trust_class: "verified-derived",
        source_ref: sourceRef,
        source_digest: record.source_digest,
        transaction_time: recordedAt,
        valid_from: recordedAt,
        valid_to: null,
      });
      atomicWrite(
        paths.facts,
        jsonl([...facts.values()].sort((a, b) => a.version_id.localeCompare(b.version_id))),
      );
    }
    return record;
  });
}

export function rebuildMemory({ projectRoot, runId }) {
  const paths = memoryPaths(projectRoot);
  return withMemoryLock(paths, () => {
    atomicWrite(paths.facts, "");
    atomicWrite(paths.candidates, "");
    return { rebuilt: true, run_id: runId ?? null };
  });
}

export function retrieveMemoryContext({ projectRoot, seed, limit = 50 }) {
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  const decisions = readJsonl(paths.decisions);
  const rejected = new Set(
    decisions.filter((item) => item.decision === "rejected").map((item) => item.candidate_id),
  );
  const superseded = new Set(
    decisions
      .filter((item) => ["superseded", "invalidated"].includes(item.decision))
      .map((item) => item.candidate_id),
  );
  const queryTokens = tokens(seed);
  return readJsonl(paths.facts)
    .filter(
      (item) =>
        item.repository_id === paths.repositoryId &&
        !rejected.has(item.version_id) &&
        !superseded.has(item.version_id) &&
        memorySourceCurrent(paths, item) &&
        ["authoritative", "verified-derived"].includes(item.trust_class),
    )
    .map((item) => ({
      item,
      score: [...queryTokens].filter((token) =>
        tokens(`${item.logical_id} ${canonicalJson(item.attributes)}`).has(token),
      ).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.logical_id.localeCompare(b.item.logical_id))
    .slice(0, Math.min(limit, 200))
    .map(({ item }) => ({
      logical_id: item.logical_id,
      kind: item.kind,
      trust_class: item.trust_class,
      source_ref: item.source_ref,
      source_digest: item.source_digest,
      attributes: item.attributes,
    }));
}
