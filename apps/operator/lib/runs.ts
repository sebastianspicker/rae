/** Projects durable pipeline runs into the console's bounded public view. */
import { existsSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, resolve } from "node:path";
import {
  ensureRuntimeStateReadable,
  graphStatus,
  listCheckpoints,
  memoryStatus,
  projectOperatorEvents,
  readOperatorEventsAfter,
  readOperatorControl,
  inspectRuntimeStateGuard,
} from "@rae/engine";
import { validateRunId } from "./security.js";
import type { OperatorProject } from "./security.js";
import type { OperatorEvent, OperatorRun } from "../static/js/types.js";

type JsonRecord = Record<string, unknown>;
interface PipelineState extends JsonRecord {
  run_id?: string;
  current_phase?: string;
  phase_order?: string[];
  completed_gates?: string[];
  workspace?: { primary_repo_root?: string; branch?: string; mode?: string };
}
interface DiscoveredDirectory {
  id: string;
  workspaceRoot: string;
  state: PipelineState;
}
export interface InternalRun extends OperatorRun {
  workspaceRoot: string;
  state?: PipelineState;
  checkpoints?: Array<JsonRecord & { status?: string }>;
  phase_order?: string[];
  completed_gates?: string[];
}
interface RunCursor {
  v: 1;
  started_at: string | null;
  id: string;
}
interface DiscoveryOptions {
  view?: "summary" | "detail";
}
interface PageOptions extends DiscoveryOptions {
  cursor?: string | null;
  limit?: number;
}
interface EventPageOptions {
  after?: number;
  limit?: number;
}
interface CatalogSnapshot {
  runs: InternalRun[];
  signatures: Map<string, string>;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

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
const execFileAsync = promisify(execFile);

function readJson<T>(pathValue: string, fallback: T): T {
  if (!existsSync(pathValue)) return fallback;
  try {
    return JSON.parse(readFileSync(pathValue, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function registeredWorktrees(projectRoot: string): string[] {
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

function belongsToProject(
  state: PipelineState,
  workspaceRoot: string,
  projectRoot: string,
): boolean {
  const declared = state.workspace?.primary_repo_root;
  if (!declared) return workspaceRoot === projectRoot;
  try {
    return realpathSync(declared) === projectRoot;
  } catch {
    return false;
  }
}

function runDirectories(workspaceRoot: string, projectRoot: string): DiscoveredDirectory[] {
  const state = readJson<PipelineState | null>(
    join(workspaceRoot, ".pipeline", "pipeline-state.json"),
    null,
  );
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

export function discoverRuns(
  project: OperatorProject,
  { view = "detail" }: DiscoveryOptions = {},
): InternalRun[] {
  const found = new Map<string, InternalRun>();
  const projectRoot = realpathSync(project.root);
  for (const workspaceRoot of registeredWorktrees(projectRoot)) {
    for (const run of workspaceRuns(project, workspaceRoot, projectRoot, view)) {
      if (!found.has(run.id)) found.set(run.id, run);
    }
  }
  return [...found.values()].sort(compareRunKeys);
}

function compareRunKeys(
  left: Pick<OperatorRun, "id" | "started_at">,
  right: Pick<OperatorRun, "id" | "started_at">,
): number {
  const time = String(right.started_at ?? "").localeCompare(String(left.started_at ?? ""));
  return time || String(right.id).localeCompare(String(left.id));
}

export function encodeRunCursor(run: Pick<OperatorRun, "id" | "started_at">): string {
  return Buffer.from(
    JSON.stringify({ v: 1, started_at: run.started_at ?? null, id: run.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeRunCursor(value: string | null): RunCursor | null {
  if (value === null) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") throw new Error("invalid");
    const cursor = decoded as Partial<RunCursor>;
    if (
      cursor.v !== 1 ||
      (cursor.started_at !== null && typeof cursor.started_at !== "string") ||
      typeof cursor.id !== "string" ||
      !cursor.id
    )
      throw new Error("invalid");
    if (Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url") !== value)
      throw new Error("invalid");
    return cursor as RunCursor;
  } catch {
    throw Object.assign(new Error("invalid run cursor"), { status: 400 });
  }
}

function isAfterCursor(run: InternalRun, cursor: RunCursor | null): boolean {
  if (!cursor) return true;
  return compareRunKeys(run, cursor) > 0;
}

/** Reconciles filesystem changes asynchronously and applies keysets before detail reads. */
export { RunCatalog } from "./catalog-client.js";
export class CatalogIndex {
  private readonly refreshes = new Map<string, Promise<CatalogSnapshot>>();
  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private closed = false;

  async page(
    project: OperatorProject,
    { cursor = null, limit = 30, view = "detail" }: PageOptions = {},
  ): Promise<{ runs: OperatorRun[]; next_cursor: string | null }> {
    if (this.closed) throw new Error("run catalog is closed");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Object.assign(new Error("invalid run page limit"), { status: 400 });
    const key = decodeRunCursor(cursor);
    const candidates = (await this.reconcile(project)).runs.filter((run) =>
      isAfterCursor(run, key),
    );
    const summaries = candidates.slice(0, limit);
    const runs =
      view === "summary"
        ? summaries.map(publicRunSummary)
        : await mapWithConcurrency(summaries, 4, async (run) => {
            await new Promise<void>((resolveReady) => setImmediate(resolveReady));
            return publicRun(projectRunDetails(project, run));
          });
    return {
      runs,
      next_cursor:
        candidates.length > summaries.length && summaries.length
          ? encodeRunCursor(summaries.at(-1)!)
          : null,
    };
  }

  async locate(
    project: OperatorProject,
    runId: string,
    { view = "detail" }: DiscoveryOptions = {},
  ): Promise<InternalRun> {
    validateRunId(runId);
    if (this.closed) throw new Error("run catalog is closed");
    const run = (await this.reconcile(project)).runs.find((candidate) => candidate.id === runId);
    if (!run) throw Object.assign(new Error("run not found"), { status: 404 });
    return view === "summary" ? run : projectRunDetails(project, run);
  }

  close(): void {
    this.closed = true;
    this.refreshes.clear();
    this.snapshots.clear();
  }

  private reconcile(project: OperatorProject): Promise<CatalogSnapshot> {
    const current = this.refreshes.get(project.id);
    if (current) return current;
    const refresh = discoverRunSummaries(project, this.snapshots.get(project.id))
      .then((snapshot) => {
        if (!this.closed) this.snapshots.set(project.id, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.refreshes.get(project.id) === refresh) this.refreshes.delete(project.id);
      });
    this.refreshes.set(project.id, refresh);
    return refresh;
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await transform(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function readJsonAsync<T>(pathValue: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(pathValue, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function registeredWorktreesAsync(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8", timeout: 10_000 },
    );
    const candidates = stdout
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    const roots = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await realpath(candidate);
        } catch {
          return null;
        }
      }),
    );
    return [...new Set([projectRoot, ...roots.filter((root): root is string => root !== null)])];
  } catch {
    return [projectRoot];
  }
}

async function runDirectoriesAsync(
  workspaceRoot: string,
  projectRoot: string,
): Promise<DiscoveredDirectory[]> {
  const state = await readJsonAsync<PipelineState | null>(
    join(workspaceRoot, ".pipeline", "pipeline-state.json"),
    null,
  );
  if (!state || !belongsToProject(state, workspaceRoot, projectRoot)) return [];
  try {
    const entries = await readdir(join(workspaceRoot, ".pipeline", "runs"), {
      withFileTypes: true,
    });
    return entries.flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      try {
        validateRunId(entry.name);
        return [{ id: entry.name, workspaceRoot, state }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function lightweightRunAsync(
  project: OperatorProject,
  run: DiscoveredDirectory,
): Promise<InternalRun> {
  const runDir = join(run.workspaceRoot, ".pipeline", "runs", run.id);
  const [request, control, runtimeActive] = await Promise.all([
    readJsonAsync<JsonRecord>(join(runDir, "request.json"), {}),
    readJsonAsync<JsonRecord>(join(runDir, "operator-control.json"), {
      schema_version: "1.0.0",
      run_id: run.id,
      status: "running",
      stop_requested: false,
      updated_at: null,
    }),
    access(join(runDir, "autonomous.lock")).then(
      () => true,
      () => false,
    ),
  ]);
  const legacyStarted =
    typeof request.requested_at === "string"
      ? request.requested_at
      : projectedEvents(run, runDir)[0]?.ts;
  return {
    id: run.id,
    project_id: project.id,
    ...runIdentity(request, control, [], run),
    ...runWorkspace(run),
    started_at:
      legacyStarted ?? (typeof control.updated_at === "string" ? control.updated_at : null),
    updated_at:
      typeof control.updated_at === "string" ? control.updated_at : (legacyStarted ?? null),
    runtime_active: runtimeActive,
    workspaceRoot: run.workspaceRoot,
    state: run.state,
  };
}

async function fileIdentity(pathValue: string): Promise<string> {
  try {
    const info = await lstat(pathValue, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.uid}:${info.nlink}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function runSignature(run: DiscoveredDirectory): Promise<string> {
  const runDir = join(run.workspaceRoot, ".pipeline", "runs", run.id);
  const identities = await Promise.all([
    fileIdentity(join(runDir, "request.json")),
    fileIdentity(join(runDir, "operator-control.json")),
    fileIdentity(join(runDir, "autonomous.lock")),
    fileIdentity(join(runDir, "trace.jsonl")),
  ]);
  return identities.join("|");
}

async function workspaceRunSummaries(
  project: OperatorProject,
  workspaceRoot: string,
  projectRoot: string,
  previousRuns: ReadonlyMap<string, InternalRun>,
  previousSignatures: ReadonlyMap<string, string>,
): Promise<CatalogSnapshot> {
  const before = guardedWorkspaceRun(project, workspaceRoot);
  if (before) return { runs: [before], signatures: new Map() };
  const directories = await runDirectoriesAsync(workspaceRoot, projectRoot);
  const signatures = new Map<string, string>();
  const stateIdentity = await fileIdentity(join(workspaceRoot, ".pipeline/pipeline-state.json"));
  const runs = await mapWithConcurrency(directories, 32, async (run) => {
    const cacheKey = `${run.workspaceRoot}\0${run.id}`;
    const signature = `${stateIdentity}|${await runSignature(run)}`;
    signatures.set(cacheKey, signature);
    const cached = previousRuns.get(cacheKey);
    return cached && previousSignatures.get(cacheKey) === signature
      ? cached
      : lightweightRunAsync(project, run);
  });
  const after = guardedWorkspaceRun(project, workspaceRoot);
  return after ? { runs: [after], signatures: new Map() } : { runs, signatures };
}

async function discoverRunSummaries(
  project: OperatorProject,
  previous?: CatalogSnapshot,
): Promise<CatalogSnapshot> {
  const projectRoot = await realpath(project.root);
  const roots = await registeredWorktreesAsync(projectRoot);
  const previousRuns = new Map(
    (previous?.runs ?? []).map((run) => [`${run.workspaceRoot}\0${run.id}`, run]),
  );
  const groups = await mapWithConcurrency(roots, 8, (workspaceRoot) =>
    workspaceRunSummaries(
      project,
      workspaceRoot,
      projectRoot,
      previousRuns,
      previous?.signatures ?? new Map(),
    ),
  );
  const found = new Map<string, InternalRun>();
  const signatures = new Map<string, string>();
  for (const group of groups) {
    for (const run of group.runs) if (!found.has(run.id)) found.set(run.id, run);
    for (const [key, signature] of group.signatures) signatures.set(key, signature);
  }
  return { runs: [...found.values()].sort(compareRunKeys), signatures };
}

function workspaceRuns(
  project: OperatorProject,
  workspaceRoot: string,
  projectRoot: string,
  view: "summary" | "detail",
): InternalRun[] {
  const before = guardedWorkspaceRun(project, workspaceRoot);
  if (before) return [before];
  const runs = runDirectories(workspaceRoot, projectRoot).map((run) =>
    view === "summary" ? lightweightRun(project, run) : summarizeRun(project, run),
  );
  const after = guardedWorkspaceRun(project, workspaceRoot);
  return after ? [after] : runs;
}

function guardedWorkspaceRun(project: OperatorProject, workspaceRoot: string): InternalRun | null {
  const guard = inspectRuntimeStateGuard(workspaceRoot) as {
    found: boolean;
    ownerActive?: boolean;
    runId?: string;
    phase?: string;
    createdAt?: string;
  };
  if (!guard.found) return null;
  if (!guard.ownerActive) {
    ensureRuntimeStateReadable(workspaceRoot, { expectedRunId: guard.runId });
    return null;
  }
  return {
    id: guard.runId ?? "guarded-run",
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

export function locateRun(
  project: OperatorProject,
  runId: string,
  { view = "detail" }: DiscoveryOptions = {},
): InternalRun {
  validateRunId(runId);
  const run = discoverRuns(project, { view: "summary" }).find(
    (candidate) => candidate.id === runId,
  );
  if (!run) throw Object.assign(new Error("run not found"), { status: 404 });
  return view === "summary" ? run : projectRunDetails(project, run);
}

function lightweightRun(project: OperatorProject, run: DiscoveredDirectory): InternalRun {
  const runDir = join(run.workspaceRoot, ".pipeline", "runs", run.id);
  const request = readJson<JsonRecord>(join(runDir, "request.json"), {});
  const control = record(readOperatorControl(run.id, run.workspaceRoot));
  // Older runs recorded their start only in the trace. Preserve their list order.
  const startedAt =
    request.requested_at ?? projectedEvents(run, runDir)[0]?.ts ?? control.updated_at ?? null;
  return {
    id: run.id,
    project_id: project.id,
    ...runIdentity(request, control, [], run),
    ...runWorkspace(run),
    started_at: typeof startedAt === "string" ? startedAt : null,
    updated_at:
      typeof control.updated_at === "string"
        ? control.updated_at
        : typeof request.requested_at === "string"
          ? request.requested_at
          : null,
    runtime_active: existsSync(join(runDir, "autonomous.lock")),
    workspaceRoot: run.workspaceRoot,
    state: run.state,
  };
}

/** Detail projection is performed only after discovery and pagination. */
export function projectRunDetails(project: OperatorProject, run: InternalRun): InternalRun {
  const before = guardedWorkspaceRun(project, run.workspaceRoot);
  if (before) return before;
  const result =
    run.guarded || !run.state
      ? locateRun(project, run.id)
      : summarizeRun(project, run as DiscoveredDirectory);
  return guardedWorkspaceRun(project, run.workspaceRoot) ?? result;
}

export function publicRunSummary(run: InternalRun): OperatorRun {
  const { workspaceRoot: _root, state: _state, ...summary } = run;
  return summary;
}

function gateRows(runDir: string): Array<{ phase: string; status: string; artifact_ref?: string }> {
  return PHASES.map((phase) => {
    const fileName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
    const gate = readJson<JsonRecord | null>(join(runDir, "gates", fileName), null);
    return {
      phase,
      status: typeof gate?.status === "string" ? gate.status : "pending",
      ...(typeof gate?.artifact_ref === "string" ? { artifact_ref: gate.artifact_ref } : {}),
    };
  });
}

function checkpoints(runDir: string): Array<JsonRecord & { status?: string }> {
  const runId = basename(runDir);
  const workspaceRoot = resolve(runDir, "../../..");
  return (listCheckpoints(runId, workspaceRoot) as JsonRecord[]).map((item) => ({
    checkpoint_id: item.checkpoint_id,
    request_key: item.request_key,
    phase: item.phase,
    purpose: item.purpose,
    status: typeof item.status === "string" ? item.status : undefined,
    message: item.message,
    requested_by: item.requested_by,
    requested_at: item.requested_at,
    decision: item.decision ?? null,
    resolved_at: item.resolved_at ?? null,
  }));
}

function projectedEvents(run: DiscoveredDirectory, runDir: string): OperatorEvent[] {
  if (!existsSync(join(runDir, "trace.jsonl"))) return [];
  try {
    return projectOperatorEvents(run.id, run.workspaceRoot) as OperatorEvent[];
  } catch {
    return [];
  }
}

function runTiming(
  request: JsonRecord,
  events: OperatorEvent[],
  runDir: string,
): { startedAt: string | null; updatedAt: string | null } {
  const startedAtValue =
    request.requested_at ??
    events[0]?.ts ??
    record(readJson<unknown>(join(runDir, "operator-control.json"), null)).updated_at ??
    null;
  const controlUpdated = record(
    readOperatorControl(basename(runDir), resolve(runDir, "../../..")),
  ).updated_at;
  const startedAt = typeof startedAtValue === "string" ? startedAtValue : null;
  return {
    startedAt,
    updatedAt:
      typeof controlUpdated === "string" ? controlUpdated : (events.at(-1)?.ts ?? startedAt),
  };
}

function runResources(progress: JsonRecord, events: OperatorEvent[]) {
  const costs = record(progress.cost_summary);
  return {
    input: typeof costs.total_tokens_in === "number" ? costs.total_tokens_in : null,
    output: typeof costs.total_tokens_out === "number" ? costs.total_tokens_out : null,
    cost: typeof costs.total_cost_usd === "number" ? costs.total_cost_usd : null,
    agent_calls: events.filter((event) => event.event === "agent_call").length,
  };
}

function summarizeRun(project: OperatorProject, run: DiscoveredDirectory): InternalRun {
  const runDir = join(run.workspaceRoot, ".pipeline", "runs", run.id);
  const request = readJson<JsonRecord>(join(runDir, "request.json"), {});
  const control = record(readOperatorControl(run.id, run.workspaceRoot));
  const progress = readJson<JsonRecord>(join(runDir, "progress.summary.json"), {});
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

function workflowProjection(request: JsonRecord, runDir: string): JsonRecord | null {
  const workflow = record(request.workflow);
  if (workflow.mode !== "graph-native") return null;
  const snapshot = record(workflow.snapshot);
  return {
    workflow_id: workflow.workflow_id,
    schema_version: snapshot.schema_version ?? request.schema_version,
    digest: workflow.digest,
    revision: workflow.revision,
    budgets: snapshot.budgets ?? {},
    instances: workflowInstances(runDir),
  };
}

function workflowInstances(runDir: string): JsonRecord[] {
  const root = join(runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  const latest = new Map<string, JsonRecord>();
  for (const nodeEntry of readdirSync(root, { withFileTypes: true })) {
    if (!nodeEntry.isDirectory()) continue;
    collectLatestInstances(latest, join(root, nodeEntry.name));
  }
  return [...latest.values()].sort(compareInstances);
}

function collectLatestInstances(latest: Map<string, JsonRecord>, directory: string): void {
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    addLatestInstance(latest, readJson<JsonRecord | null>(join(directory, name), null));
  }
}

function addLatestInstance(latest: Map<string, JsonRecord>, envelope: JsonRecord | null): void {
  if (!envelope || envelope.workflow_digest === undefined) return;
  const instanceId = String(envelope.instance_id ?? envelope.node_id ?? "");
  const prior = latest.get(instanceId);
  if (!prior || Number(envelope.attempt) >= Number(prior.attempt))
    latest.set(instanceId, publicInstance(envelope, instanceId));
}

function publicInstance(envelope: JsonRecord, instanceId: string): JsonRecord {
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

function nullableProperty(source: JsonRecord, key: string): unknown {
  return propertyOr(source, key, null);
}

function propertyOr(source: JsonRecord, key: string, fallback: unknown): unknown {
  return source[key] ?? fallback;
}

function compareInstances(left: JsonRecord, right: JsonRecord): number {
  return String(left.instance_id).localeCompare(String(right.instance_id));
}

function publicGraphHealth(workspaceRoot: string, runId: string): JsonRecord {
  const status = record(graphStatus({ projectRoot: workspaceRoot, runId }));
  const memory = graphMemoryHealth(workspaceRoot);
  return {
    ...publicGraphStatus(status),
    stale_memory: memory.stale_facts ?? 0,
    unresolved_conflicts: graphConflicts(status, memory),
  };
}

function graphMemoryHealth(workspaceRoot: string): JsonRecord {
  try {
    return record(memoryStatus(workspaceRoot));
  } catch {
    return { stale_facts: 0, unresolved_conflicts: 1 };
  }
}

function publicGraphStatus(status: JsonRecord): JsonRecord {
  return {
    available: status.available,
    valid: status.valid,
    node_count: status.node_count ?? 0,
    edge_count: status.edge_count ?? 0,
    stale_sources: status.stale_sources ?? 0,
  };
}

function graphConflicts(status: JsonRecord, memory: JsonRecord): number {
  return Number(status.unresolved_conflicts ?? 0) + Number(memory.unresolved_conflicts ?? 0);
}

function runIdentity(
  request: JsonRecord,
  control: JsonRecord,
  events: OperatorEvent[],
  run: DiscoveredDirectory,
): JsonRecord {
  return {
    task: runTask(request, run.id),
    status: control.status,
    needs_human_decision:
      typeof control.waiting_checkpoint_id === "string" &&
      control.waiting_checkpoint_id.length > 0,
    stop_requested: control.stop_requested === true,
    current_phase: runPhase(run, events),
    phase_order: runPhaseOrder(run),
    completed_gates: runCompletedGates(run),
  };
}
function runTask(request: JsonRecord, runId: string): string {
  return typeof request.task === "string" ? request.task.split("\n")[0].slice(0, 240) : runId;
}
function runPhase(run: DiscoveredDirectory, events: OperatorEvent[]): string {
  return run.state.run_id === run.id
    ? (run.state.current_phase ?? "arm")
    : (events.at(-1)?.phase ?? "arm");
}
function runPhaseOrder(run: DiscoveredDirectory): string[] {
  return Array.isArray(run.state.phase_order) ? run.state.phase_order : PHASES;
}
function runCompletedGates(run: DiscoveredDirectory): string[] {
  return Array.isArray(run.state.completed_gates) ? run.state.completed_gates : [];
}
function runWorkspace(run: DiscoveredDirectory): JsonRecord {
  return {
    branch: run.state.workspace?.branch ?? "",
    workspace_mode: run.state.workspace?.mode ?? "main-repo",
    workspace_label: basename(run.workspaceRoot),
  };
}

export function publicRun(
  run: OperatorRun & Partial<Pick<InternalRun, "workspaceRoot" | "state">>,
  ownedRunId: string | null = null,
): OperatorRun {
  const { workspaceRoot: _private, state: _state, ...value } = run;
  const pendingCheckpoint = (run.checkpoints ?? []).some((item) => item.status === "pending");
  const deniedCheckpoint = (run.checkpoints ?? []).some((item) =>
    ["rejected", "escalated"].includes(item.status ?? ""),
  );
  return {
    ...value,
    needs_human_decision: pendingCheckpoint || run.needs_human_decision === true,
    controls: {
      stop: !run.guarded && ["running", "waiting"].includes(run.status ?? ""),
      interrupt: run.id === ownedRunId,
      resume:
        !run.guarded &&
        !run.runtime_active &&
        !pendingCheckpoint &&
        !deniedCheckpoint &&
        (["running", "waiting", "stopped", "blocked", "interrupted"].includes(run.status ?? "") ||
          (run.status === "completed" &&
            (run.phase_order ?? []).some(
              (phase) => !(run.completed_gates ?? []).includes(`${phase}-gate`),
            ))),
      cleanup:
        !run.guarded &&
        ["stopped", "blocked", "interrupted", "completed"].includes(run.status ?? ""),
    },
  };
}

export function paginatedEvents(
  run: InternalRun,
  { after = 0, limit = 100 }: EventPageOptions = {},
): { events: OperatorEvent[]; next_after: number; has_more: boolean } {
  if (run.guarded) {
    throw Object.assign(
      new Error(`run ${run.id} is in guarded phase ${run.current_phase}; events are unavailable`),
      { status: 409, code: "E_PIPELINE_PHASE_ACTIVE" },
    );
  }
  return readOperatorEventsAfter(run.id, run.workspaceRoot, { after, limit }) as {
    events: OperatorEvent[];
    next_after: number;
    has_more: boolean;
  };
}
