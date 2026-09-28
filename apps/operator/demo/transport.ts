/** In-memory API and NDJSON transport for the Pages demo. It never calls fetch. */

import { createDemoFixtures, demoWorkflowTemplate } from "./fixtures.js";
import type { DemoFixtures } from "./fixtures.js";
import type { OperatorTransport } from "../static/js/api.js";
import type {
  OperatorEvent,
  OperatorRun,
  WorkflowDefinition,
  WorkflowRecord,
} from "../static/js/types.js";

type HttpError = Error & { status: number };
type JsonRecord = Record<string, unknown>;
interface RunCursor {
  v: 1;
  started_at: string | null;
  id: string;
}

const clone = <T>(value: T): T => structuredClone(value);
const jsonBody = (options?: RequestInit): JsonRecord => {
  if (!options?.body) return {};
  if (typeof options.body !== "string") return fail("mock request body must be JSON text", 400);
  const parsed: unknown = JSON.parse(options.body);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : fail("mock request body must be an object", 400);
};
const route = (path: string): URL => new URL(path, "https://demo.invalid");
const fail = (message: string, status = 404): never => {
  const error = new Error(message) as HttpError;
  error.status = status;
  throw error;
};

const compareRuns = (
  left: Pick<OperatorRun, "id" | "started_at">,
  right: Pick<OperatorRun, "id" | "started_at">,
): number =>
  String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")) ||
  String(right.id).localeCompare(String(left.id));
const encodeCursor = (run: Pick<OperatorRun, "id" | "started_at">): string =>
  btoa(JSON.stringify({ v: 1, started_at: run.started_at ?? null, id: run.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
function decodeCursor(value: string | null): RunCursor | null {
  if (value === null) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const cursor: unknown = JSON.parse(atob(normalized));
    if (!cursor || typeof cursor !== "object") throw new Error("invalid");
    const candidate = cursor as Partial<RunCursor>;
    if (
      candidate.v !== 1 ||
      (candidate.started_at !== null && typeof candidate.started_at !== "string") ||
      typeof candidate.id !== "string" ||
      !candidate.id ||
      encodeCursor(candidate as RunCursor) !== value
    )
      throw new Error("invalid");
    return candidate as RunCursor;
  } catch {
    return fail("invalid run cursor", 400);
  }
}

function eventRecord(
  store: DemoFixtures,
  run: OperatorRun,
  event: string,
  status = "pass",
): OperatorEvent {
  store.events[run.id] ??= [];
  const records = store.events[run.id];
  const record = {
    seq: records.length + 1,
    ts: new Date().toISOString(),
    phase: run.current_phase,
    event,
    status,
  };
  records.push(record);
  run.updated_at = record.ts;
  return record;
}

function findRun(store: DemoFixtures, runId: string | undefined): OperatorRun {
  const run = store.runs.find((item) => item.id === runId);
  return run ?? fail("mock run not found");
}

function assertDemoResumable(run: OperatorRun): void {
  if (run.runtime_active || !run.controls?.resume)
    fail("mock run cannot resume in its current state", 409);
}

function runMutation(
  store: DemoFixtures,
  run: OperatorRun,
  action: string | undefined,
  body: JsonRecord,
): OperatorRun {
  const actionName = action ?? "";
  if (["interrupt", "cleanup"].includes(actionName) && body.confirm_run_id !== run.id)
    fail("confirmation does not match the selected mock run", 400);
  if (action === "stop") {
    run.status = "stop-requested";
    run.runtime_active = true;
    run.controls = { stop: false, resume: true, interrupt: true, cleanup: false };
  } else if (action === "resume") {
    assertDemoResumable(run);
    run.status = "running";
    run.runtime_active = true;
    run.controls = { stop: true, resume: false, interrupt: true, cleanup: false };
  } else if (action === "interrupt") {
    run.status = "interrupted";
    run.runtime_active = false;
    run.controls = { stop: false, resume: true, interrupt: false, cleanup: true };
  } else if (action === "cleanup") {
    run.status = "cleaned";
    run.runtime_active = false;
    run.controls = { stop: false, resume: false, interrupt: false, cleanup: false };
  } else if (action === "checkpoint-decision") {
    decideDemoCheckpoint(run, body);
  } else fail("mock action not found");
  eventRecord(
    store,
    run,
    actionName.replace("-", " "),
    actionName === "checkpoint-decision" && typeof body.decision === "string"
      ? body.decision
      : "pass",
  );
  return clone(run);
}

function decideDemoCheckpoint(run: OperatorRun, body: JsonRecord): void {
  const checkpoint =
    run.checkpoints?.find((item) => item.checkpoint_id === body.checkpoint_id) ??
    fail("a pending checkpoint is required", 409);
  if (checkpoint.status !== "pending") fail("a pending checkpoint is required", 409);
  if (typeof body.rationale !== "string" || !body.rationale.trim() || body.rationale.length > 4096)
    fail("a rationale of at most 4096 characters is required", 400);
  const outcomes: Record<string, string> = {
    approve: "approved",
    reject: "rejected",
    escalate: "escalated",
  };
  const outcome = typeof body.decision === "string" ? outcomes[body.decision] : undefined;
  if (!outcome || typeof body.decision_id !== "string") fail("invalid checkpoint decision", 400);
  const at = new Date().toISOString();
  checkpoint.status = outcome;
  checkpoint.resolved_at = at;
  checkpoint.decision = {
    decision_id: body.decision_id,
    outcome,
    actor: "rae-loopback-operator",
    at,
    rationale: body.rationale,
  };
  run.needs_human_decision = false;
  run.status = outcome === "approved" ? "running" : "blocked";
  run.controls = {
    stop: outcome === "approved",
    resume: outcome === "approved" && !run.runtime_active,
    interrupt: false,
    cleanup: outcome !== "approved",
  };
}

function workflowSummary(record: WorkflowRecord): Record<string, unknown> {
  return {
    workflow_id: record.workflow_id,
    latest_revision: record.revisions?.at(-1)?.revision ?? record.workflow.revision,
    active: record.active,
  };
}

function workflowRoute(
  store: DemoFixtures,
  parts: string[],
  method: string,
  body: JsonRecord,
): unknown {
  if (!parts.length && method === "GET")
    return { workflows: [...store.workflows.values()].map(workflowSummary) };
  if (parts[0] === "templates") {
    if (method === "GET") return { templates: clone(store.templates) };
    const definition = demoWorkflowTemplate(String(body.template_id ?? ""), Number(body.revision));
    definition.workflow_id = String(body.workflow_id ?? "");
    return { workflow: definition };
  }
  const record = store.workflows.get(parts[0]) ?? fail("mock workflow not found");
  if (parts.length === 1 && method === "GET") return { workflow: clone(record) };
  if (parts[1] === "analysis") {
    const inputWorkflow =
      body.workflow && typeof body.workflow === "object"
        ? (body.workflow as Partial<WorkflowDefinition>)
        : null;
    return {
      available: true,
      analysis: {
        valid: true,
        nodes: inputWorkflow?.nodes?.length ?? 0,
        edges: inputWorkflow?.edges?.length ?? 0,
        source: "mock-only",
      },
    };
  }
  if (parts[1] === "proposals") {
    if (parts.length === 2 && method === "POST") {
      const id = "proposal-demo-00000000-0000-4000-8000-000000000001";
      const candidate: WorkflowDefinition = clone(record.workflow);
      candidate.revision = (record.revisions?.at(-1)?.revision ?? record.workflow.revision) + 1;
      candidate.title = `${candidate.title} proposal`;
      store.proposal = { id, workflow_id: record.workflow_id, state: "completed", candidate };
      return { id };
    }
    if (parts.length === 3 && method === "GET") return { proposal: clone(store.proposal) };
  }
  if (parts[1] === "drafts" && method === "POST") {
    const definition = clone(body.workflow) as WorkflowDefinition;
    const revision = {
      revision: definition.revision,
      workflow: definition,
      digest: `demo-digest-r${definition.revision}`,
    };
    record.revisions ??= [];
    record.revisions.push(revision);
    record.workflow = definition;
    record.digest = revision.digest;
    return { revision: clone(revision) };
  }
  if (parts[1] === "diff" && method === "GET")
    return { diff: { source: "mock-only", changed: ["nodes", "edges"] } };
  if (parts[1] === "revisions" && parts[3] === "validate")
    return { validation: { valid: true, revision: Number(parts[2]), source: "mock-only" } };
  if (parts[1] === "revisions" && parts[3] === "activate") {
    const revision = Number(parts[2]);
    const selected =
      record.revisions?.find((item) => item.revision === revision) ??
      fail("mock revision not found");
    if (body.digest !== selected.digest) fail("mock digest confirmation does not match", 400);
    record.active = { workflow_id: record.workflow_id, revision };
    record.activation_history ??= [];
    record.activation_history.push({ revision, activated_at: new Date().toISOString() });
    return { activation: clone(record.active) };
  }
  return fail("mock workflow route not found");
}

/** Creates a fresh, deterministic in-memory transport for each demo page or test. */
export function createDemoTransport(
  fixtures: DemoFixtures = createDemoFixtures(),
): OperatorTransport & { fixtures: DemoFixtures } {
  const store = fixtures;
  const request = async (path: string, options: RequestInit = {}): Promise<unknown> => {
    const url = route(path);
    const method = (options.method ?? "GET").toUpperCase();
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "projects") return fail("mock API path must start with projects");
    if (parts.length === 1 && method === "GET") return { projects: clone(store.projects) };
    if (parts[2] === "execution-profiles" && method === "GET")
      return { profiles: clone(store.profiles) };
    if (parts[2] === "workflows")
      return workflowRoute(store, parts.slice(3), method, jsonBody(options));
    if (parts[2] !== "runs") return fail("mock API route not found");
    if (parts.length === 3) {
      if (method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const cursor = decodeCursor(url.searchParams.get("cursor"));
        const candidates = [...store.runs]
          .sort(compareRuns)
          .filter((run) => !cursor || compareRuns(run, cursor) > 0);
        const page = candidates.slice(0, limit);
        const runs =
          url.searchParams.get("view") === "summary"
            ? page.map(
                ({
                  gates: _gates,
                  evidence: _evidence,
                  resources: _resources,
                  checkpoints: _checkpoints,
                  workflow: _workflow,
                  graph_health: _graph,
                  controls: _controls,
                  ...summary
                }) => summary,
              )
            : page;
        return {
          runs: clone(runs),
          next_cursor:
            candidates.length > page.length && page.length ? encodeCursor(page.at(-1)!) : null,
        };
      }
      const body = jsonBody(options);
      const run = baseDemoRun(
        typeof body.task === "string" ? body.task : "",
        store.runs.length + 1,
      );
      store.runs.unshift(run);
      store.events[run.id] = [];
      eventRecord(store, run, "mock run created", "pending");
      return { run: clone(run) };
    }
    const run = findRun(store, parts[3]);
    if (parts.length === 4 && method === "GET") return { run: clone(run) };
    if (parts[4] === "events" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const remaining = (store.events[run.id] ?? []).filter((item) => item.seq > after);
      const events = remaining.slice(0, Number(url.searchParams.get("limit") ?? 100));
      return {
        events: clone(events),
        next_after: events.at(-1)?.seq ?? after,
        has_more: remaining.length > events.length,
      };
    }
    return { control: runMutation(store, run, parts[4], jsonBody(options)) };
  };
  return {
    request,
    async eventStream(path: string): Promise<Response> {
      const url = route(path);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const run = findRun(store, parts[3]);
      const after = Number(url.searchParams.get("after") ?? 0);
      const body = new TextEncoder().encode(
        (store.events[run.id] ?? [])
          .filter((event) => event.seq > after)
          .map((event) => `${JSON.stringify(event)}\n`)
          .join(""),
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            if (body.length) controller.enqueue(body);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
    fixtures: store,
  };
}

function baseDemoRun(task: string, suffix: number): OperatorRun {
  return {
    id: `run-demo-new-${suffix}`,
    task: task || "Untitled mock run",
    branch: "rae/mock-run",
    workspace_mode: "isolated",
    workspace_label: "Mock worktree",
    status: "running",
    runtime_active: true,
    current_phase: "inspect",
    phase_order: ["inspect", "plan", "verify", "ship"],
    gates: [],
    completed_gates: [],
    evidence: { present: 0 },
    resources: { input: 0, output: 0, cost: 0, agent_calls: 0 },
    checkpoints: [],
    controls: { stop: true, resume: false, interrupt: true, cleanup: false },
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    workflow: { workflow_id: "repository-change", digest: "demo-validated-digest", instances: [] },
  };
}
