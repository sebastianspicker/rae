/** Projects pipeline artifacts, decisions, and command evidence into graph records. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
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
} from "./core.js";
import type { GraphBuilder, GraphSource } from "./core.js";

type ProjectionSource = Omit<GraphSource, "family" | "trust"> &
  Partial<Pick<GraphSource, "family" | "trust">>;
interface ArtifactRecord extends Record<string, unknown> {
  id?: unknown;
  constraint_id?: unknown;
  finding_id?: unknown;
  claim_id?: unknown;
  requirements?: ArtifactRecord[];
  constraints?: ArtifactRecord[];
  constraints_classification?: ArtifactRecord[];
  task_groups?: ArtifactRecord[];
  tasks?: ArtifactRecord[];
  test_cases?: ArtifactRecord[];
  covers_requirement_ids?: unknown[];
  deduplicated_findings?: ArtifactRecord[];
  findings?: ArtifactRecord[];
  violations?: ArtifactRecord[];
  claims?: ArtifactRecord[];
  snapshot?: ArtifactRecord;
  nodes?: ArtifactRecord[];
  edges?: ArtifactRecord[];
  decision?: ArtifactRecord;
}

function asArtifact(value: unknown): ArtifactRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ArtifactRecord)
    : {};
}

function addArtifactChild(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  family: string,
  kind: string,
  id: unknown,
  attributes: Record<string, unknown>,
  edgeKind: string | null,
): string {
  const child = addNode(graph, {
    ...source,
    family,
    trust: "model-proposed",
    kind,
    id: String(id),
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

function projectArtifactRequirements(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  artifact: ArtifactRecord,
): void {
  for (const requirement of artifact.requirements ?? [])
    projectArtifactRequirement(graph, source, artifactId, requirement);
}

function projectArtifactRequirement(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  requirement: ArtifactRecord,
): void {
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

function projectArtifactConstraints(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  artifact: ArtifactRecord,
): void {
  for (const constraint of artifact.constraints ?? artifact.constraints_classification ?? [])
    projectArtifactConstraint(graph, source, artifactId, constraint);
}

function projectArtifactConstraint(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  constraint: ArtifactRecord,
): void {
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

function artifactRecordKey(record: ArtifactRecord, fallbackKey: string): string {
  return String(record.id ?? record[fallbackKey] ?? sha256(canonicalJson(record)).slice(0, 16));
}

function projectTaskCoverage(
  graph: GraphBuilder,
  source: ProjectionSource,
  from: string,
  requirementIds: unknown[] | undefined,
  kind: string,
): void {
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

function projectTaskTests(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  task: ArtifactRecord,
  taskId: string,
): void {
  for (const test of task.test_cases ?? [])
    projectTaskTest(graph, source, artifactId, task, taskId, test);
}

function projectTaskTest(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  task: ArtifactRecord,
  taskId: string,
  test: ArtifactRecord,
): void {
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

function projectArtifactTasks(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  artifact: ArtifactRecord,
): void {
  for (const group of artifact.task_groups ?? []) {
    for (const task of group.tasks ?? []) projectArtifactTask(graph, source, artifactId, task);
  }
}

function projectArtifactTask(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  task: ArtifactRecord,
): void {
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

function projectArtifactEvidence(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  phase: string,
  artifact: ArtifactRecord,
): void {
  projectArtifactFindings(graph, source, artifactId, phase, artifact);
  projectArtifactClaims(graph, source, artifactId, phase, artifact);
}

function projectArtifactFindings(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  phase: string,
  artifact: ArtifactRecord,
): void {
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

function findingAttributes(finding: ArtifactRecord): Record<string, unknown> {
  return {
    severity: finding.severity ?? "unknown",
    summary: finding.summary ?? finding.message ?? "",
  };
}

function projectArtifactClaims(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  phase: string,
  artifact: ArtifactRecord,
): void {
  for (const claim of artifact.claims ?? [])
    projectArtifactClaim(graph, source, artifactId, phase, claim);
}

function projectArtifactClaim(
  graph: GraphBuilder,
  source: ProjectionSource,
  artifactId: string,
  phase: string,
  claim: ArtifactRecord,
): void {
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

function artifactNode(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runNode: string,
  phase: keyof typeof PHASE_ARTIFACTS,
  source: ProjectionSource,
): string | null {
  const rel = relative(root, resolve(runDir, PHASE_ARTIFACTS[phase]));
  const absolute = resolve(root, rel);
  if (!safeRegularFile(absolute, root)) return null;
  const hash = sourceDigest(root, rel);
  const artifact = asArtifact(readJson(absolute));
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

export function projectPhaseEvidence(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  phase: keyof typeof PHASE_ARTIFACTS,
  previous: string | null,
  runNode: string,
  source: ProjectionSource,
): string {
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

export function projectPhaseGate(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  phase: string,
  phaseNode: string,
  artifact: string | null,
  source: ProjectionSource,
): void {
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
    id: String(gate.gate_id ?? `${runId}:${phase}`),
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

export function projectRunEvidence(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  source: ProjectionSource,
  repoNode: string,
): void {
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
  const request = asArtifact(readJson(resolve(root, requestRel)));
  const workflow = asArtifact(request.workflow);
  if (workflow.mode === "graph-native") {
    projectWorkflowRun(graph, root, runDir, runId, source, runNode, workflow);
  } else {
    let previous = null;
    for (const phase of PHASES)
      previous = projectPhaseEvidence(graph, root, runDir, runId, phase, previous, runNode, source);
  }
  projectCheckpointDecisions(graph, root, runDir, runId, source);
}

function projectWorkflowRun(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  source: ProjectionSource,
  runNode: string,
  workflowRecord: ArtifactRecord,
): void {
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

function projectWorkflowRevision(
  graph: GraphBuilder,
  snapshotSource: ProjectionSource,
  runNode: string,
  workflowRecord: ArtifactRecord,
): string {
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
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  source: ProjectionSource,
  revision: string,
  snapshotSource: ProjectionSource,
  workflowRecord: ArtifactRecord,
): Map<unknown, string> {
  const nodeIds = new Map<unknown, string>();
  for (const node of asArtifact(workflowRecord.snapshot).nodes ?? []) {
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
    projectNodeAttempts(graph, root, runDir, runId, String(node.id), graphNode, source);
  }
  return nodeIds;
}

function projectWorkflowEdges(
  graph: GraphBuilder,
  nodeIds: Map<unknown, string>,
  snapshotSource: ProjectionSource,
  workflowRecord: ArtifactRecord,
): void {
  for (const edge of asArtifact(workflowRecord.snapshot).edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    projectWorkflowEdge(graph, nodeIds, snapshotSource, edge);
  }
}

function projectWorkflowEdge(
  graph: GraphBuilder,
  nodeIds: Map<unknown, string>,
  snapshotSource: ProjectionSource,
  edge: ArtifactRecord,
): void {
  const attributes: Record<string, unknown> = { edge_type: edge.type };
  attributes.condition = edge.condition ?? null;
  attributes.artifact = edge.artifact ?? null;
  addEdge(graph, {
    ...snapshotSource,
    family: "workflow",
    trust: "verified-derived",
    kind: edge.type === "loop-back" ? "NEXT" : "DEPENDS_ON",
    from: nodeIds.get(edge.to) as string,
    to: nodeIds.get(edge.from) as string,
    attributes,
  });
}

function projectNodeAttempts(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  nodeId: string,
  nodeGraphId: string,
  source: ProjectionSource,
): void {
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

export function projectCheckpointDecisions(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  source: ProjectionSource,
): void {
  const directory = resolve(runDir, "checkpoints");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  ))
    projectCheckpointEntry(graph, root, directory, runId, source, entry);
}

function projectCheckpointEntry(
  graph: GraphBuilder,
  root: string,
  directory: string,
  runId: string,
  source: ProjectionSource,
  entry: Dirent,
): void {
  if (!entry.isFile() || extname(entry.name) !== ".json") return;
  const rel = relative(root, resolve(directory, entry.name));
  if (!safeRegularFile(resolve(root, rel), root)) return;
  const checkpoint = asArtifact(readJson(resolve(root, rel)));
  if (!hasProjectableCheckpointDecision(checkpoint)) return;
  const checkpointSource = { ...source, sourceRef: rel, sourceHash: sourceDigest(root, rel) };
  const node = addNode(graph, {
    ...checkpointSource,
    family: "evidence",
    trust: "authoritative",
    kind: "CheckpointDecision",
    id: String(checkpoint.checkpoint_id ?? `${runId}:${entry.name}`),
    attributes: {
      phase: checkpoint.phase,
      status: checkpoint.status,
      actor: asArtifact(checkpoint.decision).actor,
    },
  });
  projectCheckpointAuthorization(graph, checkpointSource, runId, checkpoint, node);
}

function hasProjectableCheckpointDecision(checkpoint: ArtifactRecord): boolean {
  return (
    Boolean(checkpoint.decision) &&
    typeof checkpoint.status === "string" &&
    ["approved", "rejected", "escalated"].includes(checkpoint.status)
  );
}

function projectCheckpointAuthorization(
  graph: GraphBuilder,
  source: ProjectionSource,
  runId: string,
  checkpoint: ArtifactRecord,
  node: string,
): void {
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

function commandFromEvent(
  line: string,
  index: number,
): { item: ArtifactRecord; command: string } | null {
  try {
    const event = asArtifact(JSON.parse(line) as unknown);
    const item = asArtifact(event.item ?? event);
    if (item.type !== "command_execution") return null;
    return {
      item,
      command: Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? ""),
    };
  } catch {
    throw new Error(`corrupt agent event JSONL at line ${index + 1}`);
  }
}

function linkCommandTests(
  graph: GraphBuilder,
  source: ProjectionSource,
  commandNode: string,
  command: string,
): void {
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

export function projectCommandEvents(
  graph: GraphBuilder,
  root: string,
  runDir: string,
  runId: string,
  phase: string,
  phaseNode: string,
  source: ProjectionSource,
): void {
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
