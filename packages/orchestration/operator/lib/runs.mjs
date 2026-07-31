/** Projects durable pipeline runs into the console's bounded public view. */
import { existsSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { projectOperatorEvents } from "../../scripts/pipeline/lib/trace.mjs";
import {
  listCheckpoints,
  readOperatorControl,
} from "../../scripts/pipeline/lib/operator-control.mjs";
import {
  ensureRuntimeStateReadable,
  inspectRuntimeStateGuard,
} from "../../scripts/pipeline/lib/runtime-state-guard.mjs";
import { validateRunId } from "./security.mjs";
import { graphStatus, memoryStatus } from "../../scripts/pipeline/lib/graph.mjs";

const PHASES = [
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "release-readiness",
];

function readJson(pathValue, fallback = null) {
  if (!existsSync(pathValue)) return fallback;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch {
    return fallback;
  }
}

function registeredWorktrees(projectRoot) {
  const result = spawnSync(
    "git",
    ["-C", projectRoot, "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) return [projectRoot];
  const roots = new Set([projectRoot]);
  for (const field of result.stdout.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const candidate = field.slice("worktree ".length);
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // A concurrently removed worktree is not a durable run source.
    }
  }
  return [...roots];
}

function belongsToProject(state, workspaceRoot, projectRoot) {
  const declared = state?.workspace?.primary_repo_root;
  if (!declared) return workspaceRoot === projectRoot;
  try {
    return realpathSync(declared) === projectRoot;
  } catch {
    return false;
  }
}

function runDirectories(workspaceRoot, projectRoot) {
  const state = readJson(join(workspaceRoot, ".pipeline", "pipeline-state.json"));
  if (!state || !belongsToProject(state, workspaceRoot, projectRoot)) return [];
  const runsRoot = join(workspaceRoot, ".pipeline", "runs");
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        validateRunId(entry.name);
        return [{ id: entry.name, workspaceRoot, state }];
      } catch {
        return [];
      }
    });
}

export function discoverRuns(project) {
  const found = new Map();
  const projectRoot = realpathSync(project.root);
  for (const workspaceRoot of registeredWorktrees(projectRoot)) {
    for (const run of workspaceRuns(project, workspaceRoot, projectRoot)) {
      if (!found.has(run.id)) found.set(run.id, run);
    }
  }
  return [...found.values()].sort((left, right) =>
    String(right.started_at).localeCompare(String(left.started_at)),
  );
}

function workspaceRuns(project, workspaceRoot, projectRoot) {
  const before = guardedWorkspaceRun(project, workspaceRoot);
  if (before) return [before];
  const runs = runDirectories(workspaceRoot, projectRoot).map((run) => summarizeRun(project, run));
  const after = guardedWorkspaceRun(project, workspaceRoot);
  return after ? [after] : runs;
}

function guardedWorkspaceRun(project, workspaceRoot) {
  const guard = inspectRuntimeStateGuard(workspaceRoot);
  if (!guard.found || guardIsReadableInactive(guard, workspaceRoot)) return null;
  return activeGuardedWorkspaceRun(project, workspaceRoot, guard);
}

function guardIsReadableInactive(guard, workspaceRoot) {
  if (guard.ownerActive) return false;
  ensureRuntimeStateReadable(workspaceRoot, { expectedRunId: guard.runId });
  return true;
}

function activeGuardedWorkspaceRun(project, workspaceRoot, guard) {
  return {
    id: guard.runId,
    project_id: project.id,
    task: "Guarded workspace-write phase in progress",
    status: "phase-active",
    stop_requested: false,
    current_phase: guard.phase ?? "build",
    phase_order: PHASES,
    completed_gates: [],
    branch: "",
    workspace_mode: "guarded",
    workspace_label: basename(workspaceRoot),
    started_at: guard.createdAt ?? null,
    updated_at: guard.createdAt ?? null,
    runtime_active: true,
    guarded: true,
    gates: PHASES.map((phase) => ({ phase, status: "pending" })),
    evidence: { present: 0 },
    resources: { input: null, output: null, cost: null, agent_calls: 0 },
    checkpoints: [],
    workspaceRoot,
  };
}

export function locateRun(project, runId) {
  validateRunId(runId);
  const run = discoverRuns(project).find((candidate) => candidate.id === runId);
  if (!run) throw Object.assign(new Error("run not found"), { status: 404 });
  return run;
}

function gateRows(runDir) {
  return PHASES.map((phase) => {
    const fileName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
    const gate = readJson(join(runDir, "gates", fileName));
    return {
      phase,
      status: typeof gate?.status === "string" ? gate.status : "pending",
      ...(typeof gate?.artifact_ref === "string" ? { artifact_ref: gate.artifact_ref } : {}),
    };
  });
}

function checkpoints(runDir) {
  const runId = basename(runDir);
  const workspaceRoot = resolve(runDir, "../../..");
  return listCheckpoints(runId, workspaceRoot).map((item) => ({
    checkpoint_id: item.checkpoint_id,
    request_key: item.request_key,
    phase: item.phase,
    purpose: item.purpose,
    status: item.status,
    message: item.message,
    requested_by: item.requested_by,
    requested_at: item.requested_at,
    decision: item.decision ?? null,
    resolved_at: item.resolved_at ?? null,
  }));
}

function projectedEvents(run, runDir) {
  if (!existsSync(join(runDir, "trace.jsonl"))) return [];
  try {
    return projectOperatorEvents(run.id, run.workspaceRoot);
  } catch {
    return [];
  }
}

function runTiming(request, events, runDir) {
  const startedAt = runStartTime(request, events, runDir);
  return {
    startedAt,
    updatedAt: runUpdatedTime(events, runDir, startedAt),
  };
}

function runStartTime(request, events, runDir) {
  if (request.requested_at) return request.requested_at;
  return eventOrControlStartTime(events, runDir);
}

function eventOrControlStartTime(events, runDir) {
  if (events[0]?.ts) return events[0].ts;
  return readJson(join(runDir, "operator-control.json"))?.updated_at ?? null;
}

function runUpdatedTime(events, runDir, startedAt) {
  return (
    readOperatorControl(basename(runDir), resolve(runDir, "../../..")).updated_at ??
    events.at(-1)?.ts ??
    startedAt
  );
}

function runResources(progress, events) {
  return {
    input: progress.cost_summary?.total_tokens_in ?? null,
    output: progress.cost_summary?.total_tokens_out ?? null,
    cost: progress.cost_summary?.total_cost_usd ?? null,
    agent_calls: events.filter((event) => event.event === "agent_call").length,
  };
}

function summarizeRun(project, run) {
  const runDir = join(run.workspaceRoot, ".pipeline", "runs", run.id);
  const request = readJson(join(runDir, "request.json"), {});
  const control = readOperatorControl(run.id, run.workspaceRoot);
  const progress = readJson(join(runDir, "progress.summary.json"), {});
  const events = projectedEvents(run, runDir);
  const { startedAt, updatedAt } = runTiming(request, events, runDir);
  const projectedArtifacts = events.filter((event) => event.event === "artifact_write");
  const checkpointRows = checkpoints(runDir);
  const workflow = workflowProjection(request, runDir);
  return {
    id: run.id,
    project_id: project.id,
    ...runIdentity(request, control, events, run),
    ...runWorkspace(run),
    workspace_label: basename(run.workspaceRoot),
    started_at: startedAt,
    updated_at: updatedAt,
    runtime_active: existsSync(join(runDir, "autonomous.lock")),
    gates: gateRows(runDir),
    evidence: { present: projectedArtifacts.length },
    resources: runResources(progress, events),
    checkpoints: checkpointRows,
    workflow,
    graph_health: publicGraphHealth(run.workspaceRoot, run.id),
    workspaceRoot: run.workspaceRoot,
  };
}

function workflowProjection(request, runDir) {
  if (request.workflow?.mode !== "graph-native") return null;
  return {
    workflow_id: request.workflow.workflow_id,
    schema_version: request.workflow.snapshot?.schema_version ?? request.schema_version,
    digest: request.workflow.digest,
    revision: request.workflow.revision,
    budgets: request.workflow.snapshot?.budgets ?? {},
    instances: workflowInstances(runDir),
  };
}

function workflowInstances(runDir) {
  const root = join(runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  const latest = new Map();
  for (const nodeEntry of readdirSync(root, { withFileTypes: true })) {
    if (!nodeEntry.isDirectory()) continue;
    collectLatestInstances(latest, join(root, nodeEntry.name));
  }
  return [...latest.values()].sort(compareInstances);
}

function collectLatestInstances(latest, directory) {
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    addLatestInstance(latest, readJson(join(directory, name)));
  }
}

function addLatestInstance(latest, envelope) {
  if (!envelope || envelope.workflow_digest === undefined) return;
  const instanceId = envelope.instance_id ?? envelope.node_id;
  const prior = latest.get(instanceId);
  if (!prior || envelope.attempt >= prior.attempt)
    latest.set(instanceId, publicInstance(envelope, instanceId));
}

function publicInstance(envelope, instanceId) {
  return {
    instance_id: instanceId,
    node_id: envelope.node_id,
    parent_node: nullableProperty(envelope, "parent_node"),
    item_key: nullableProperty(envelope, "item_key"),
    item_digest: nullableProperty(envelope, "item_digest"),
    status: envelope.status,
    attempt: envelope.attempt,
    execution_tier: propertyOr(envelope, "execution_tier", "runtime"),
    selection: nullableProperty(envelope, "selection"),
    quorum: nullableProperty(envelope, "quorum"),
    convergence: nullableProperty(envelope, "convergence"),
  };
}

function nullableProperty(record, key) {
  return propertyOr(record, key, null);
}

function propertyOr(record, key, fallback) {
  return record[key] ?? fallback;
}

function compareInstances(left, right) {
  return left.instance_id.localeCompare(right.instance_id);
}

function publicGraphHealth(workspaceRoot, runId) {
  const status = graphStatus({ projectRoot: workspaceRoot, runId });
  const memory = graphMemoryHealth(workspaceRoot);
  return {
    ...publicGraphStatus(status),
    stale_memory: memory.stale_facts ?? 0,
    unresolved_conflicts: graphConflicts(status, memory),
  };
}

function graphMemoryHealth(workspaceRoot) {
  try {
    return memoryStatus(workspaceRoot);
  } catch {
    return { stale_facts: 0, unresolved_conflicts: 1 };
  }
}

function publicGraphStatus(status) {
  return {
    available: status.available,
    valid: status.valid,
    node_count: status.node_count ?? 0,
    edge_count: status.edge_count ?? 0,
    stale_sources: status.stale_sources ?? 0,
  };
}

function graphConflicts(status, memory) {
  return (status.unresolved_conflicts ?? 0) + (memory.unresolved_conflicts ?? 0);
}

function runIdentity(request, control, events, run) {
  return {
    task: runTask(request, run.id),
    status: control.status,
    stop_requested: control.stop_requested === true,
    current_phase: runPhase(run, events),
    phase_order: runPhaseOrder(run),
    completed_gates: runCompletedGates(run),
  };
}
function runTask(request, runId) {
  return typeof request.task === "string" ? request.task.split("\n")[0].slice(0, 240) : runId;
}
function runPhase(run, events) {
  return run.state.run_id === run.id ? run.state.current_phase : (events.at(-1)?.phase ?? "arm");
}
function runPhaseOrder(run) {
  return Array.isArray(run.state.phase_order) ? run.state.phase_order : PHASES;
}
function runCompletedGates(run) {
  return Array.isArray(run.state.completed_gates) ? run.state.completed_gates : [];
}
function runWorkspace(run) {
  return {
    branch: run.state.workspace?.branch ?? "",
    workspace_mode: run.state.workspace?.mode ?? "main-repo",
    workspace_label: basename(run.workspaceRoot),
  };
}

export function publicRun(run, ownedRunId = null) {
  const { workspaceRoot: _private, ...value } = run;
  const pendingCheckpoint = run.checkpoints.some((item) => item.status === "pending");
  const deniedCheckpoint = run.checkpoints.some((item) =>
    ["rejected", "escalated"].includes(item.status),
  );
  return {
    ...value,
    controls: {
      stop: !run.guarded && ["running", "waiting"].includes(run.status),
      interrupt: run.id === ownedRunId,
      resume:
        !run.guarded &&
        !run.runtime_active &&
        !pendingCheckpoint &&
        !deniedCheckpoint &&
        (["running", "waiting", "stopped", "blocked", "interrupted"].includes(run.status) ||
          (run.status === "completed" &&
            run.phase_order.some((phase) => !run.completed_gates.includes(`${phase}-gate`)))),
      cleanup:
        !run.guarded && ["stopped", "blocked", "interrupted", "completed"].includes(run.status),
    },
  };
}

export function paginatedEvents(run, { after = 0, limit = 100 } = {}) {
  if (run.guarded) {
    throw Object.assign(
      new Error(`run ${run.id} is in guarded phase ${run.current_phase}; events are unavailable`),
      { status: 409, code: "E_PIPELINE_PHASE_ACTIVE" },
    );
  }
  ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
  const tracePath = join(run.workspaceRoot, ".pipeline", "runs", run.id, "trace.jsonl");
  if (!existsSync(tracePath)) {
    ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
    return { events: [], next_after: after, has_more: false };
  }
  const events = projectOperatorEvents(run.id, run.workspaceRoot)
    .filter((event) => event.seq > after)
    .slice(0, limit);
  ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
  return {
    events,
    next_after: events.at(-1)?.seq ?? after,
    has_more: events.length === limit,
  };
}
