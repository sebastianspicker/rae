/** Supplies sanitized, in-memory API responses for the static operator-console demonstration. */

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

const SIMULATED_ACTION_IDS = [
  "new-run-button",
  "start-submit",
  "stop-button",
  "interrupt-button",
  "resume-button",
  "cleanup-button",
  "confirm-submit",
];

const baseRun = {
  phase_order: PHASES,
  workspace_mode: "worktree",
  evidence: { present: 6 },
  resources: { agent_calls: 11, input: 184220, output: 28310, cost: null },
  graph_health: {
    available: false,
    valid: false,
    node_count: 0,
    edge_count: 0,
    stale_sources: 0,
    stale_memory: 0,
    unresolved_conflicts: 0,
  },
};

const runs = [
  {
    ...baseRun,
    id: "run-7f3a2c91",
    task: "Add a tested health endpoint and document the public behavior.",
    branch: "pipeline/run-7f3a2c91",
    workspace_label: ".git/rae-worktrees/run-7f3a2c91",
    status: "awaiting",
    current_phase: "build",
    started_at: "2026-07-23T14:02:00.000Z",
    updated_at: "2026-07-23T14:08:00.000Z",
    completed_gates: [
      "arm-gate",
      "design-gate",
      "adversarial-review-gate",
      "plan-gate",
      "pmatch-gate",
    ],
    gates: [
      { gate_id: "arm-gate", phase: "arm", status: "pass", artifact_ref: "brief · a91f" },
      { gate_id: "design-gate", phase: "design", status: "pass", artifact_ref: "design · 3c20" },
      {
        gate_id: "adversarial-review-gate",
        phase: "adversarial-review",
        status: "pass",
        artifact_ref: "review · 88e1",
      },
      { gate_id: "plan-gate", phase: "plan", status: "pass", artifact_ref: "plan · b7d4" },
      { gate_id: "pmatch-gate", phase: "pmatch", status: "pass", artifact_ref: "drift · 0f2a" },
      {
        gate_id: "build-gate",
        phase: "build",
        status: "pending",
        artifact_ref: "build · 7c…e19",
      },
    ],
    checkpoints: [
      {
        checkpoint_id: "cp-4b91-build",
        purpose: "mutation",
        phase: "build",
        status: "pending",
        message:
          "Plan-owned implementation is staged. Gate policy before-mutation-and-ship requires an operator record before quality-static runs.",
        requested_at: "2026-07-23T14:08:00.000Z",
      },
    ],
    controls: { stop: true, interrupt: true, resume: false, cleanup: false },
  },
  {
    ...baseRun,
    id: "run-91bc08d2",
    task: "Harden report path confinement for Ralph fixing transactions.",
    branch: "pipeline/run-91bc08d2",
    workspace_label: ".git/rae-worktrees/run-91bc08d2",
    status: "completed",
    current_phase: "release-readiness",
    started_at: "2026-07-23T12:42:00.000Z",
    updated_at: "2026-07-23T13:12:00.000Z",
    completed_gates: PHASES.map((phase) => `${phase}-gate`),
    gates: PHASES.map((phase, index) => ({
      gate_id: `${phase}-gate`,
      phase,
      status: "pass",
      artifact_ref: `evidence · ${String(index + 1).padStart(2, "0")}`,
    })),
    checkpoints: [],
    controls: { stop: false, interrupt: false, resume: false, cleanup: true },
  },
  {
    ...baseRun,
    id: "run-2e11d4a0",
    task: "Correct a scoped documentation claim without widening the change set.",
    branch: "pipeline/run-2e11d4a0",
    workspace_label: ".git/rae-worktrees/run-2e11d4a0",
    status: "blocked",
    current_phase: "pmatch",
    started_at: "2026-07-23T11:20:00.000Z",
    updated_at: "2026-07-23T11:58:00.000Z",
    completed_gates: ["arm-gate", "design-gate", "adversarial-review-gate", "plan-gate"],
    gates: [
      { gate_id: "arm-gate", phase: "arm", status: "pass", artifact_ref: "brief · d102" },
      { gate_id: "design-gate", phase: "design", status: "pass", artifact_ref: "design · 73a4" },
      {
        gate_id: "adversarial-review-gate",
        phase: "adversarial-review",
        status: "pass",
        artifact_ref: "review · 220c",
      },
      { gate_id: "plan-gate", phase: "plan", status: "pass", artifact_ref: "plan · c814" },
      { gate_id: "pmatch-gate", phase: "pmatch", status: "failed", artifact_ref: "drift · 91ff" },
    ],
    checkpoints: [],
    controls: { stop: false, interrupt: false, resume: true, cleanup: true },
  },
];

const eventsByRun = new Map(
  Object.entries({
    "run-7f3a2c91": [
      {
        seq: 1,
        ts: "2026-07-23T14:02:05.000Z",
        phase: "arm",
        event: "artifact_recorded",
        artifact_ref: "brief · a91f",
        status: "pass",
        tier: "local",
      },
      {
        seq: 2,
        ts: "2026-07-23T14:03:18.000Z",
        phase: "design",
        event: "gate_completed",
        gate_id: "design-gate",
        status: "pass",
        tier: "local",
      },
      {
        seq: 3,
        ts: "2026-07-23T14:04:42.000Z",
        phase: "adversarial-review",
        event: "review_completed",
        artifact_ref: "review · 88e1",
        status: "pass",
        tier: "local",
      },
      {
        seq: 4,
        ts: "2026-07-23T14:06:09.000Z",
        phase: "plan",
        event: "plan_validated",
        artifact_ref: "plan · b7d4",
        status: "pass",
        tier: "local",
      },
      {
        seq: 5,
        ts: "2026-07-23T14:07:31.000Z",
        phase: "pmatch",
        event: "drift_check_completed",
        gate_id: "pmatch-gate",
        status: "pass",
        tier: "local",
      },
      {
        seq: 6,
        ts: "2026-07-23T14:08:00.000Z",
        phase: "build",
        event: "checkpoint_requested",
        event_id: "cp-4b91-build",
        status: "pending",
        tier: "human",
      },
    ],
    "run-91bc08d2": [
      {
        seq: 1,
        ts: "2026-07-23T12:42:03.000Z",
        phase: "arm",
        event: "run_started",
        event_id: "evt-01",
        status: "pass",
        tier: "local",
      },
      {
        seq: 2,
        ts: "2026-07-23T13:12:00.000Z",
        phase: "release-readiness",
        event: "release_gate_completed",
        gate_id: "release-readiness-gate",
        status: "pass",
        tier: "local",
      },
    ],
    "run-2e11d4a0": [
      {
        seq: 1,
        ts: "2026-07-23T11:20:02.000Z",
        phase: "arm",
        event: "run_started",
        event_id: "evt-01",
        status: "pass",
        tier: "local",
      },
      {
        seq: 2,
        ts: "2026-07-23T11:58:00.000Z",
        phase: "pmatch",
        event: "drift_detected",
        gate_id: "pmatch-gate",
        status: "failed",
        tier: "local",
      },
    ],
  }),
);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bodyOf(options) {
  return options.body ? JSON.parse(options.body) : {};
}

function updateRun(run, changes) {
  Object.assign(run, changes, { updated_at: "2026-07-23T14:24:00.000Z" });
}

function applyCheckpointDecision(run, body) {
  const checkpoint = run.checkpoints.find((item) => item.checkpoint_id === body.checkpoint_id);
  if (!checkpoint) return json({ error: { message: "Fixture checkpoint not found." } }, 404);
  checkpoint.status = body.decision;
  if (body.decision === "approve") {
    const buildGate = run.gates.find((gate) => gate.gate_id === "build-gate");
    buildGate.status = "pass";
    if (!run.completed_gates.includes("build-gate")) run.completed_gates.push("build-gate");
    updateRun(run, { status: "running", current_phase: "quality-static" });
  } else {
    updateRun(run, { status: body.decision === "reject" ? "blocked" : "awaiting" });
  }
  const events = eventsByRun.get(run.id);
  events.push({
    seq: events.length + 1,
    ts: run.updated_at,
    phase: checkpoint.phase,
    event: `checkpoint_${body.decision}`,
    event_id: checkpoint.checkpoint_id,
    status: body.decision,
    tier: "human",
  });
  return json({ ok: true, simulated: true });
}

function createRun(body) {
  const id = `run-demo-${String(runs.length + 1).padStart(2, "0")}`;
  const run = {
    ...structuredClone(baseRun),
    id,
    task: body.task,
    branch: `pipeline/${id}`,
    workspace_label: `.git/rae-worktrees/${id}`,
    status: "awaiting",
    current_phase: "arm",
    started_at: "2026-07-23T14:24:00.000Z",
    updated_at: "2026-07-23T14:24:00.000Z",
    completed_gates: [],
    gates: [
      { gate_id: "arm-gate", phase: "arm", status: "pending", artifact_ref: "brief · fixture" },
    ],
    checkpoints: [
      {
        checkpoint_id: `${id}-arm`,
        purpose: "mutation",
        phase: "arm",
        status: "pending",
        message: "This simulated run is waiting at its first fixture checkpoint.",
        requested_at: "2026-07-23T14:24:00.000Z",
      },
    ],
    controls: { stop: true, interrupt: true, resume: false, cleanup: false },
  };
  runs.unshift(run);
  eventsByRun.set(id, [
    {
      seq: 1,
      ts: run.started_at,
      phase: "arm",
      event: "fixture_run_created",
      event_id: `${id}-created`,
      status: "pending",
      tier: "simulation",
    },
  ]);
  return json({ run_id: id, simulated: true }, 202);
}

function streamResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      if (signal?.aborted) {
        controller.close();
        return;
      }
      signal?.addEventListener("abort", () => controller.close(), { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function getResponse(path, options) {
  if (path === "/projects") {
    return json({
      projects: [{ id: "project_fixture", label: "sebastianspicker/rae · fixture" }],
    });
  }
  if (path.endsWith("/events/stream")) return streamResponse(options.signal);

  const eventsMatch = path.match(/^\/projects\/[^/]+\/runs\/([^/]+)\/events$/);
  if (eventsMatch) {
    const events = structuredClone(eventsByRun.get(decodeURIComponent(eventsMatch[1])) || []);
    return json({ events, next_after: events.at(-1)?.seq || 0 });
  }

  if (/^\/projects\/[^/]+\/runs$/.test(path)) return json({ runs: structuredClone(runs) });
  return null;
}

function actionStatus(action) {
  if (action === "stop") return "stopping";
  if (action === "resume") return "running";
  return "interrupted";
}

function postAction(actionMatch, options) {
  const runId = decodeURIComponent(actionMatch[1]);
  const action = actionMatch[2];
  const run = runs.find((item) => item.id === runId);
  if (!run) return json({ error: { message: "Fixture run not found." } }, 404);
  if (action === "checkpoint-decision") return applyCheckpointDecision(run, bodyOf(options));
  if (action === "cleanup") {
    runs.splice(runs.indexOf(run), 1);
    return json({ ok: true, simulated: true });
  }
  updateRun(run, { status: actionStatus(action) });
  if (action === "interrupt") {
    run.controls = { stop: false, interrupt: false, resume: true, cleanup: true };
  }
  return json({ ok: true, simulated: true });
}

function postResponse(path, options) {
  if (/^\/projects\/[^/]+\/runs$/.test(path)) return createRun(bodyOf(options));

  const actionMatch = path.match(
    /^\/projects\/[^/]+\/runs\/([^/]+)\/(stop|resume|interrupt|cleanup|checkpoint-decision)$/,
  );
  return actionMatch ? postAction(actionMatch, options) : null;
}

function demoFetch(input, options = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (!url.pathname.startsWith("/api/v1/")) {
    throw new Error("The static simulation does not permit network requests.");
  }

  const path = url.pathname.slice("/api/v1".length);
  const method = String(options.method || "GET").toUpperCase();
  const response = method === "GET" ? getResponse(path, options) : postResponse(path, options);
  return response || json({ error: { message: "Unsupported static-demo request." } }, 404);
}

function markSimulatedControls() {
  const controls = [
    ...SIMULATED_ACTION_IDS.map((id) => document.getElementById(id)),
    ...document.querySelectorAll("[data-decision]"),
  ];
  for (const control of controls) {
    if (!control || control.querySelector(".simulated-label")) continue;
    const marker = document.createElement("span");
    marker.className = "simulated-label";
    marker.textContent = "Simulated";
    marker.setAttribute("aria-hidden", "true");
    control.append(marker);
    control.setAttribute("aria-label", `${control.textContent.trim()} (simulated)`);
  }
}

history.replaceState(null, "", `${location.pathname}${location.search}#token=static-demo`);
window.fetch = demoFetch;
markSimulatedControls();
await import("../app.js");
