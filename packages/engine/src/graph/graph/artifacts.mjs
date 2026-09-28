/** Projects pipeline artifacts, decisions, and command evidence into graph records. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import {
  PHASE_ARTIFACTS,
  PHASES,
  addEdge,
  addNode,
  canonicalJson,
  readJson,
  safeRegularFile,
  sha256,
  sourceDigest,
} from "./core.mjs";

function addArtifactChild(graph, source, artifactId, family, kind, id, attributes, edgeKind) {
  const child = addNode(graph, {
    ...source,
    family,
    trust: "model-proposed",
    kind,
    id,
    attributes,
  });
  if (!edgeKind) return child;
  addEdge(graph, {
    ...source,
    family,
    trust: "model-proposed",
    kind: edgeKind,
    from: edgeKind === "DERIVED_FROM" ? child : artifactId,
    to: edgeKind === "DERIVED_FROM" ? artifactId : child,
  });
  return child;
}

function projectArtifactRequirements(graph, source, artifactId, artifact) {
  for (const requirement of artifact.requirements ?? [])
    projectArtifactRequirement(graph, source, artifactId, requirement);
}

function projectArtifactRequirement(graph, source, artifactId, requirement) {
  if (!requirement?.id) return;
  addArtifactChild(
    graph,
    source,
    artifactId,
    "evidence",
    "Requirement",
    requirement.id,
    {
      priority: requirement.priority,
      text: requirement.statement ?? requirement.description ?? "",
    },
    "CONTAINS",
  );
}

function projectArtifactConstraints(graph, source, artifactId, artifact) {
  for (const constraint of artifact.constraints ?? artifact.constraints_classification ?? [])
    projectArtifactConstraint(graph, source, artifactId, constraint);
}

function projectArtifactConstraint(graph, source, artifactId, constraint) {
  addArtifactChild(
    graph,
    source,
    artifactId,
    "evidence",
    "Constraint",
    artifactRecordKey(constraint, "constraint_id"),
    { text: constraint.statement ?? constraint.constraint ?? "" },
    "CONTAINS",
  );
}

function artifactRecordKey(record, fallbackKey) {
  return record.id ?? record[fallbackKey] ?? sha256(canonicalJson(record)).slice(0, 16);
}

function projectTaskCoverage(graph, source, from, requirementIds, kind) {
  for (const reqId of requirementIds ?? [])
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "model-proposed",
      kind,
      from,
      to: `Requirement:${reqId}`,
    });
}

function projectTaskTests(graph, source, artifactId, task, taskId) {
  for (const test of task.test_cases ?? [])
    projectTaskTest(graph, source, artifactId, task, taskId, test);
}

function projectTaskTest(graph, source, artifactId, task, taskId, test) {
  const name = test.name ?? test.trace_id;
  if (!name) return;
  const testId = addArtifactChild(
    graph,
    source,
    artifactId,
    "workflow",
    "TestCase",
    `${task.id}:${name}`,
    { name, command: test.command ?? "" },
    null,
  );
  addEdge(graph, {
    ...source,
    family: "workflow",
    trust: "model-proposed",
    kind: "VERIFIES",
    from: testId,
    to: taskId,
  });
  projectTaskCoverage(graph, source, testId, test.covers_requirement_ids, "VERIFIES");
}

function projectArtifactTasks(graph, source, artifactId, artifact) {
  for (const group of artifact.task_groups ?? []) {
    for (const task of group.tasks ?? []) projectArtifactTask(graph, source, artifactId, task);
  }
}

function projectArtifactTask(graph, source, artifactId, task) {
  if (!task?.id) return;
  const taskId = addArtifactChild(
    graph,
    source,
    artifactId,
    "workflow",
    "PlanTask",
    task.id,
    { title: task.title ?? task.description ?? "" },
    "CONTAINS",
  );
  projectTaskCoverage(graph, source, taskId, task.covers_requirement_ids, "COVERS");
  projectTaskTests(graph, source, artifactId, task, taskId);
}

function projectArtifactEvidence(graph, source, artifactId, phase, artifact) {
  projectArtifactFindings(graph, source, artifactId, phase, artifact);
  projectArtifactClaims(graph, source, artifactId, phase, artifact);
}

function projectArtifactFindings(graph, source, artifactId, phase, artifact) {
  const findings = artifact.deduplicated_findings ?? artifact.findings ?? artifact.violations ?? [];
  for (const finding of findings) {
    const key = artifactRecordKey(finding, "finding_id");
    addArtifactChild(
      graph,
      source,
      artifactId,
      "evidence",
      "Finding",
      `${phase}:${key}`,
      findingAttributes(finding),
      "DERIVED_FROM",
    );
  }
}

function findingAttributes(finding) {
  return {
    severity: finding.severity ?? "unknown",
    summary: finding.summary ?? finding.message ?? "",
  };
}

function projectArtifactClaims(graph, source, artifactId, phase, artifact) {
  for (const claim of artifact.claims ?? [])
    projectArtifactClaim(graph, source, artifactId, phase, claim);
}

function projectArtifactClaim(graph, source, artifactId, phase, claim) {
  const key = artifactRecordKey(claim, "claim_id");
  addArtifactChild(
    graph,
    source,
    artifactId,
    "evidence",
    "Claim",
    `${phase}:${key}`,
    {
      status: claim.verification_status ?? "proposed",
      text: claim.statement ?? claim.claim ?? "",
    },
    "DERIVED_FROM",
  );
}

function artifactNode(graph, root, runDir, runNode, phase, source) {
  const rel = relative(root, resolve(runDir, PHASE_ARTIFACTS[phase]));
  const absolute = resolve(root, rel);
  if (!safeRegularFile(absolute, root)) return null;
  const hash = sourceDigest(root, rel);
  const artifact = readJson(absolute);
  const artifactSource = { ...source, sourceRef: rel, sourceHash: hash };
  const artifactId = addNode(graph, {
    ...artifactSource,
    family: "evidence",
    trust: "model-proposed",
    kind: "ArtifactVersion",
    id: `${phase}:${hash}`,
    attributes: { phase, path: rel },
  });
  addEdge(graph, {
    ...artifactSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: runNode,
    to: artifactId,
  });
  projectArtifactRequirements(graph, artifactSource, artifactId, artifact);
  projectArtifactConstraints(graph, artifactSource, artifactId, artifact);
  projectArtifactTasks(graph, artifactSource, artifactId, artifact);
  projectArtifactEvidence(graph, artifactSource, artifactId, phase, artifact);
  return artifactId;
}

export function projectPhaseEvidence(graph, root, runDir, runId, phase, previous, runNode, source) {
  const phaseNode = addNode(graph, {
    ...source,
    family: "workflow",
    trust: "authoritative",
    kind: "PhaseAttempt",
    id: `${runId}:${phase}`,
    attributes: { phase },
  });
  addEdge(graph, {
    ...source,
    family: "workflow",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: runNode,
    to: phaseNode,
  });
  if (previous)
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "verified-derived",
      kind: "DEPENDS_ON",
      from: phaseNode,
      to: previous,
    });
  const artifact = artifactNode(graph, root, runDir, runNode, phase, source);
  if (artifact)
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "verified-derived",
      kind: "WRITES",
      from: phaseNode,
      to: artifact,
    });
  projectCommandEvents(graph, root, runDir, runId, phase, phaseNode, source);
  projectPhaseGate(graph, root, runDir, runId, phase, phaseNode, artifact, source);
  return phaseNode;
}

export function projectPhaseGate(graph, root, runDir, runId, phase, phaseNode, artifact, source) {
  const gateName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
  const gateRel = relative(root, resolve(runDir, "gates", gateName));
  if (!safeRegularFile(resolve(root, gateRel), root)) return;
  const hash = sourceDigest(root, gateRel);
  const gateSource = { ...source, sourceRef: gateRel, sourceHash: hash };
  const gate = readJson(resolve(root, gateRel));
  const gateNode = addNode(graph, {
    ...gateSource,
    family: "evidence",
    trust: "authoritative",
    kind: "GateDecision",
    id: gate.gate_id ?? `${runId}:${phase}`,
    attributes: { phase, status: gate.status },
  });
  addEdge(graph, {
    ...gateSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "EVALUATES",
    from: gateNode,
    to: phaseNode,
  });
  if (artifact)
    addEdge(graph, {
      ...gateSource,
      family: "evidence",
      trust: "verified-derived",
      kind: "EVALUATES",
      from: gateNode,
      to: artifact,
    });
}

export function projectRunEvidence(graph, root, runDir, runId, source, repoNode) {
  const requestRel = relative(root, resolve(runDir, "request.json"));
  if (!safeRegularFile(resolve(root, requestRel), root)) return;
  const requestHash = sourceDigest(root, requestRel);
  const requestSource = { ...source, sourceRef: requestRel, sourceHash: requestHash };
  const runNode = addNode(graph, {
    ...requestSource,
    family: "workflow",
    trust: "authoritative",
    kind: "Run",
    id: runId,
    attributes: { run_id: runId },
  });
  const requestNode = addNode(graph, {
    ...requestSource,
    family: "evidence",
    trust: "authoritative",
    kind: "SourceDocument",
    id: `${runId}:request`,
    attributes: { document_type: "run-request" },
  });
  addEdge(graph, {
    ...requestSource,
    family: "workflow",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: repoNode,
    to: runNode,
  });
  addEdge(graph, {
    ...requestSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "DERIVED_FROM",
    from: runNode,
    to: requestNode,
  });
  const request = readJson(resolve(root, requestRel));
  if (request.workflow?.mode === "graph-native") {
    projectWorkflowRun(graph, root, runDir, runId, source, runNode, request.workflow);
  } else {
    let previous = null;
    for (const phase of PHASES)
      previous = projectPhaseEvidence(graph, root, runDir, runId, phase, previous, runNode, source);
  }
  projectCheckpointDecisions(graph, root, runDir, runId, source);
}

function projectWorkflowRun(graph, root, runDir, runId, source, runNode, workflowRecord) {
  const snapshotRel = relative(root, resolve(runDir, "workflow", "snapshot.json"));
  if (!safeRegularFile(resolve(root, snapshotRel), root)) return;
  const snapshotSource = {
    ...source,
    sourceRef: snapshotRel,
    sourceHash: sourceDigest(root, snapshotRel),
  };
  const revision = projectWorkflowRevision(graph, snapshotSource, runNode, workflowRecord);
  const nodeIds = projectWorkflowNodes(
    graph,
    root,
    runDir,
    runId,
    source,
    revision,
    snapshotSource,
    workflowRecord,
  );
  projectWorkflowEdges(graph, nodeIds, snapshotSource, workflowRecord);
}

function projectWorkflowRevision(graph, snapshotSource, runNode, workflowRecord) {
  const revision = addNode(graph, {
    ...snapshotSource,
    family: "workflow",
    trust: "authoritative",
    kind: "WorkflowRevision",
    id: `${workflowRecord.workflow_id}:${workflowRecord.revision}:${workflowRecord.digest}`,
    attributes: {
      workflow_id: workflowRecord.workflow_id,
      revision: workflowRecord.revision,
      digest: workflowRecord.digest,
    },
  });
  addEdge(graph, {
    ...snapshotSource,
    family: "workflow",
    trust: "verified-derived",
    kind: "INSTANCE_OF",
    from: runNode,
    to: revision,
  });
  return revision;
}

function projectWorkflowNodes(
  graph,
  root,
  runDir,
  runId,
  source,
  revision,
  snapshotSource,
  workflowRecord,
) {
  const nodeIds = new Map();
  for (const node of workflowRecord.snapshot.nodes ?? []) {
    const kind =
      node.kind === "join" ? "Join" : node.kind === "loop" ? "LoopIteration" : "AgentNode";
    const graphNode = addNode(graph, {
      ...snapshotSource,
      family: "workflow",
      trust: "authoritative",
      kind,
      id: `${runId}:${node.id}`,
      attributes: {
        node_id: node.id,
        kind: node.kind,
        access: node.access,
        role: node.role ?? null,
      },
    });
    nodeIds.set(node.id, graphNode);
    addEdge(graph, {
      ...snapshotSource,
      family: "workflow",
      trust: "verified-derived",
      kind: "CONTAINS",
      from: revision,
      to: graphNode,
    });
    projectNodeAttempts(graph, root, runDir, runId, node.id, graphNode, source);
  }
  return nodeIds;
}

function projectWorkflowEdges(graph, nodeIds, snapshotSource, workflowRecord) {
  for (const edge of workflowRecord.snapshot.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    projectWorkflowEdge(graph, nodeIds, snapshotSource, edge);
  }
}

function projectWorkflowEdge(graph, nodeIds, snapshotSource, edge) {
  const attributes = { edge_type: edge.type };
  attributes.condition = edge.condition ?? null;
  attributes.artifact = edge.artifact ?? null;
  addEdge(graph, {
    ...snapshotSource,
    family: "workflow",
    trust: "verified-derived",
    kind: edge.type === "loop-back" ? "NEXT" : "DEPENDS_ON",
    from: nodeIds.get(edge.to),
    to: nodeIds.get(edge.from),
    attributes,
  });
}

function projectNodeAttempts(graph, root, runDir, runId, nodeId, nodeGraphId, source) {
  const directory = resolve(runDir, "workflow", "attempts", nodeId);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const rel = relative(root, resolve(directory, entry));
    if (!safeRegularFile(resolve(root, rel), root)) continue;
    const envelope = readJson(resolve(root, rel));
    const attemptSource = { ...source, sourceRef: rel, sourceHash: sourceDigest(root, rel) };
    const attempt = addNode(graph, {
      ...attemptSource,
      family: "workflow",
      trust: "authoritative",
      kind: "NodeAttempt",
      id: `${runId}:${nodeId}:${envelope.loop_iteration ?? 1}:${envelope.attempt}`,
      attributes: {
        node_id: nodeId,
        attempt: envelope.attempt,
        loop_iteration: envelope.loop_iteration ?? 1,
        status: envelope.status,
        input_digest: envelope.input_digest,
        output_digest: envelope.output_digest,
      },
    });
    addEdge(graph, {
      ...attemptSource,
      family: "workflow",
      trust: "verified-derived",
      kind: "INSTANCE_OF",
      from: attempt,
      to: nodeGraphId,
    });
  }
}

export function projectCheckpointDecisions(graph, root, runDir, runId, source) {
  const directory = resolve(runDir, "checkpoints");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  ))
    projectCheckpointEntry(graph, root, directory, runId, source, entry);
}

function projectCheckpointEntry(graph, root, directory, runId, source, entry) {
  if (!entry.isFile() || extname(entry.name) !== ".json") return;
  const rel = relative(root, resolve(directory, entry.name));
  if (!safeRegularFile(resolve(root, rel), root)) return;
  const checkpoint = readJson(resolve(root, rel));
  if (!hasProjectableCheckpointDecision(checkpoint)) return;
  const checkpointSource = { ...source, sourceRef: rel, sourceHash: sourceDigest(root, rel) };
  const node = addNode(graph, {
    ...checkpointSource,
    family: "evidence",
    trust: "authoritative",
    kind: "CheckpointDecision",
    id: checkpoint.checkpoint_id ?? `${runId}:${entry.name}`,
    attributes: {
      phase: checkpoint.phase,
      status: checkpoint.status,
      actor: checkpoint.decision.actor,
    },
  });
  projectCheckpointAuthorization(graph, checkpointSource, runId, checkpoint, node);
}

function hasProjectableCheckpointDecision(checkpoint) {
  return checkpoint.decision && ["approved", "rejected", "escalated"].includes(checkpoint.status);
}

function projectCheckpointAuthorization(graph, source, runId, checkpoint, node) {
  const phaseNode = `PhaseAttempt:${runId}:${checkpoint.phase}`;
  if (!graph.nodes.some((item) => item.logical_id === phaseNode)) return;
  addEdge(graph, {
    ...source,
    family: "evidence",
    trust: "verified-derived",
    kind: "AUTHORIZED_BY",
    from: phaseNode,
    to: node,
  });
}

function commandFromEvent(line, index) {
  try {
    const event = JSON.parse(line);
    const item = event.item ?? event;
    if (item.type !== "command_execution") return null;
    return {
      item,
      command: Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? ""),
    };
  } catch {
    throw new Error(`corrupt agent event JSONL at line ${index + 1}`);
  }
}

function linkCommandTests(graph, source, commandNode, command) {
  for (const test of graph.nodes.filter(
    (node) => node.kind === "TestCase" && node.attributes.command === command,
  )) {
    addEdge(graph, {
      ...source,
      family: "evidence",
      trust: "verified-derived",
      kind: "VERIFIES",
      from: commandNode,
      to: test.logical_id,
    });
  }
}

export function projectCommandEvents(graph, root, runDir, runId, phase, phaseNode, source) {
  const eventRel = relative(root, resolve(runDir, "agent-outputs", `${phase}.events.jsonl`));
  if (!safeRegularFile(resolve(root, eventRel), root)) return;
  const eventHash = sourceDigest(root, eventRel);
  const eventSource = { ...source, sourceRef: eventRel, sourceHash: eventHash };
  for (const [index, line] of readFileSync(resolve(root, eventRel), "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const event = commandFromEvent(line, index);
    if (!event) continue;
    const { item, command } = event;
    const commandDigest = sha256(command);
    const commandNode = addNode(graph, {
      ...eventSource,
      family: "evidence",
      trust: "authoritative",
      kind: "CommandExecution",
      id: `${runId}:${phase}:${index + 1}`,
      attributes: {
        phase,
        status: item.exit_code === 0 ? "pass" : "fail",
        command_digest: commandDigest,
      },
    });
    addEdge(graph, {
      ...eventSource,
      family: "evidence",
      trust: "verified-derived",
      kind: "CONTAINS",
      from: phaseNode,
      to: commandNode,
    });
    linkCommandTests(graph, eventSource, commandNode, command);
  }
}
