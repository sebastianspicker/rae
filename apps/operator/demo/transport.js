/** In-memory API and NDJSON transport for the Pages demo. It never calls fetch. */

import { createDemoFixtures, demoWorkflowTemplate } from "./fixtures.js";

const clone = (value) => structuredClone(value);
const jsonBody = (options) => (options?.body ? JSON.parse(options.body) : {});
const route = (path) => new URL(path, "https://demo.invalid");
const fail = (message, status = 404) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

function eventRecord(store, run, event, status = "pass") {
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

function findRun(store, runId) {
  const run = store.runs.find((item) => item.id === runId);
  return run ?? fail("mock run not found");
}

function runMutation(store, run, action, body) {
  if (["interrupt", "cleanup"].includes(action) && body.confirm_run_id !== run.id)
    fail("confirmation does not match the selected mock run", 400);
  if (action === "stop") {
    run.status = "stop-requested";
    run.runtime_active = true;
    run.controls = { stop: false, resume: true, interrupt: true, cleanup: false };
  } else if (action === "resume") {
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
    const checkpoint = run.checkpoints.find(
      (item) => item.checkpoint_id === body.checkpoint_id && item.status === "pending",
    );
    if (!checkpoint || !body.rationale?.trim())
      fail("a pending checkpoint and rationale are required", 400);
    checkpoint.status = body.decision;
    run.status = body.decision === "approve" ? "running" : "waiting";
    run.controls.resume = body.decision !== "approve";
  } else fail("mock action not found");
  eventRecord(
    store,
    run,
    action.replace("-", " "),
    action === "checkpoint-decision" ? body.decision : "pass",
  );
  return clone(run);
}

function workflowSummary(record) {
  return {
    workflow_id: record.workflow_id,
    latest_revision: record.revisions.at(-1).revision,
    active: record.active,
  };
}

function workflowRoute(store, parts, method, body) {
  if (!parts.length && method === "GET")
    return { workflows: [...store.workflows.values()].map(workflowSummary) };
  if (parts[0] === "templates") {
    if (method === "GET") return { templates: clone(store.templates) };
    const definition = demoWorkflowTemplate(body.template_id, body.revision);
    definition.workflow_id = body.workflow_id;
    return { workflow: definition };
  }
  const record = store.workflows.get(parts[0]) ?? fail("mock workflow not found");
  if (parts.length === 1 && method === "GET") return { workflow: clone(record) };
  if (parts[1] === "analysis")
    return {
      available: true,
      analysis: {
        valid: true,
        nodes: body.workflow?.nodes?.length ?? 0,
        edges: body.workflow?.edges?.length ?? 0,
        source: "mock-only",
      },
    };
  if (parts[1] === "proposals") {
    if (parts.length === 2 && method === "POST") {
      const id = "proposal-demo-00000000-0000-4000-8000-000000000001";
      const candidate = clone(record.workflow);
      candidate.revision = record.revisions.at(-1).revision + 1;
      candidate.title = `${candidate.title} proposal`;
      store.proposal = { id, workflow_id: record.workflow_id, state: "completed", candidate };
      return { id };
    }
    if (parts.length === 3 && method === "GET") return { proposal: clone(store.proposal) };
  }
  if (parts[1] === "drafts" && method === "POST") {
    const definition = clone(body.workflow);
    const revision = {
      revision: definition.revision,
      workflow: definition,
      digest: `demo-digest-r${definition.revision}`,
    };
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
      record.revisions.find((item) => item.revision === revision) ??
      fail("mock revision not found");
    if (body.digest !== selected.digest) fail("mock digest confirmation does not match", 400);
    record.active = { workflow_id: record.workflow_id, revision };
    record.activation_history.push({ revision, activated_at: new Date().toISOString() });
    return { activation: clone(record.active) };
  }
  return fail("mock workflow route not found");
}

/** Creates a fresh, deterministic in-memory transport for each demo page or test. */
export function createDemoTransport(fixtures = createDemoFixtures()) {
  const store = fixtures;
  const request = async (path, options = {}) => {
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
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const page = store.runs.slice(cursor, cursor + limit);
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
          next_cursor: cursor + page.length < store.runs.length ? cursor + page.length : null,
        };
      }
      const body = jsonBody(options);
      const run = baseDemoRun(body.task, store.runs.length + 1);
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
    async eventStream(path) {
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

function baseDemoRun(task, suffix) {
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
