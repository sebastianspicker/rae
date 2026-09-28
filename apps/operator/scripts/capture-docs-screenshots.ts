/** Captures operator documentation screenshots from current UI code and sanitized fixtures. */
import { captureViewport } from "./capture-browser.js";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";

import { compileWorkflowTemplate, listWorkflowTemplates, workflowDigest } from "@rae/engine";
import type { WorkflowDefinition } from "../static/js/types.js";

const OPERATOR_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_OPERATOR_ROOT =
  basename(OPERATOR_ROOT) === "dist" ? resolve(OPERATOR_ROOT, "..") : OPERATOR_ROOT;
const STATIC_ROOT = resolve(OPERATOR_ROOT, "static");
const SCREENSHOT_ROOT = resolve(SOURCE_OPERATOR_ROOT, "docs", "screenshots");
const TOKEN = "rae-docs-capture-token";
const PROJECT_ID = "project_docs_fixture";
const WORKFLOW = compileWorkflowTemplate("bounded-until-dry-loop", {
  workflow_id: "release-discovery",
  revision: 3,
  title: "Bounded release discovery",
  max_repair_rounds: 3,
}) as WorkflowDefinition;
const WORKFLOW_DIGEST = workflowDigest(WORKFLOW);

const RUN = Object.freeze({
  id: "run-2026-08-05-graph",
  task: "Update the operator graph designer and verify the public documentation.",
  branch: "pipeline/operator-graph-docs",
  workspace_mode: "isolated-worktree",
  workspace_label: "rae-worktree",
  status: "completed",
  runtime_active: false,
  current_phase: "release-readiness",
  phase_order: ["arm", "plan", "build", "quality-tests", "release-readiness"],
  completed_gates: ["arm-gate", "plan-gate", "build-gate", "quality-tests-gate"],
  started_at: "2026-08-05T08:32:00.000Z",
  updated_at: "2026-08-05T08:47:00.000Z",
  controls: { stop: false, interrupt: false, resume: false, cleanup: true },
  checkpoints: [],
  gates: [
    { gate_id: "arm-gate", phase: "arm", status: "pass", artifact_ref: "brief.json" },
    { gate_id: "plan-gate", phase: "plan", status: "pass", artifact_ref: "plan.json" },
    { gate_id: "build-gate", phase: "build", status: "pass", artifact_ref: "changes.json" },
    {
      gate_id: "quality-tests-gate",
      phase: "quality-tests",
      status: "pass",
      artifact_ref: "verification.json",
    },
    {
      gate_id: "release-readiness-gate",
      phase: "release-readiness",
      status: "pass",
      artifact_ref: "release.json",
    },
  ],
  evidence: { present: 12 },
  resources: { agent_calls: 8, input: 42816, output: 9312, cost: null },
  graph_health: {
    available: true,
    valid: true,
    node_count: WORKFLOW.nodes.length,
    edge_count: WORKFLOW.edges.length,
    stale_sources: 0,
    stale_memory: 0,
    unresolved_conflicts: 0,
  },
  workflow: {
    workflow_id: WORKFLOW.workflow_id,
    revision: WORKFLOW.revision,
    digest: WORKFLOW_DIGEST,
    budgets: WORKFLOW.budgets,
    instances: [
      instance("discovery-loop", "passed", 2, "control", { convergence: { dry: true } }),
      instance("discover", "passed", 2, "economy"),
      instance("assess", "passed", 2, "judgment"),
      instance("verify", "passed", 1, "control"),
      instance("complete", "passed", 1, "control"),
    ],
  },
});

const EVENTS = Object.freeze([
  event(1, "plan", "artifact_validated", "pass", "plan.json"),
  event(2, "build", "workspace_changed", "pass", "changes.json"),
  event(3, "quality-tests", "verification_completed", "pass", "verification.json"),
  event(4, "release-readiness", "workflow_completed", "pass", "release.json"),
]);

const CAPTURE_STYLE = `
  <style id="docs-capture-style">
    .ident, .trace, .task-sheet, .task-footer, #run-details { display: none !important; }
    .body { padding-top: 1.5rem; }
    #workflow-section { margin-top: 0; }
    .workflow-structure { max-height: 17rem; }
  </style>
`;
function installCaptureProbe(): void {
  window.addEventListener("error", (event) => {
    document.documentElement.dataset.captureError = event.message || "browser error";
  });
  window.addEventListener("unhandledrejection", (event) => {
    document.documentElement.dataset.captureError = event.reason?.message || "unhandled rejection";
  });
  window.addEventListener("load", () =>
    window.setTimeout(() => {
      const section = document.getElementById("workflow-section") as HTMLDetailsElement | null;
      if (section) section.open = true;
      document.getElementById("workflow-view-loop")?.click();
      document.getElementById("workflow-view-graph")?.click();
      const connected = document.getElementById("connection-status")?.dataset.state === "connected";
      const nodes = document.querySelectorAll("#workflow-graph-content .workflow-node").length;
      const selected = document
        .getElementById("workflow-view-graph")
        ?.getAttribute("aria-selected");
      document.documentElement.dataset.captureReady = String(
        connected && nodes > 0 && selected === "true",
      );
    }, 100),
  );
}
const CAPTURE_PROBE = `<script>(${installCaptureProbe.toString()})()</script>`;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

function instance(
  nodeId: string,
  status: string,
  attempt: number,
  executionTier: string,
  extra: Record<string, unknown> = {},
) {
  return {
    instance_id: nodeId,
    node_id: nodeId,
    parent_node: null,
    item_key: null,
    item_digest: null,
    status,
    attempt,
    execution_tier: executionTier,
    selection: null,
    quorum: null,
    convergence: null,
    ...extra,
  };
}

function event(seq: number, phase: string, name: string, status: string, artifactRef: string) {
  return {
    seq,
    event: name,
    phase,
    status,
    artifact_ref: artifactRef,
    ts: `2026-08-05T08:${String(35 + seq * 3).padStart(2, "0")}:00.000Z`,
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function workflowRecord() {
  return {
    workflow_id: WORKFLOW.workflow_id,
    active: {
      workflow_id: WORKFLOW.workflow_id,
      revision: WORKFLOW.revision,
      digest: WORKFLOW_DIGEST,
    },
    revisions: [
      {
        revision: WORKFLOW.revision,
        digest: WORKFLOW_DIGEST,
        workflow: WORKFLOW,
      },
    ],
    workflow: WORKFLOW,
    digest: WORKFLOW_DIGEST,
    activation_history: [{ revision: WORKFLOW.revision, activated_at: "2026-08-05T08:31:00.000Z" }],
  };
}

function apiResponse(pathname: string): unknown {
  if (pathname === "/api/v1/projects") {
    return { projects: [{ id: PROJECT_ID, label: "sebastianspicker/rae" }] };
  }
  if (pathname === `/api/v1/projects/${PROJECT_ID}/execution-profiles`) {
    return {
      profiles: [
        {
          id: "local-mixed",
          readiness: "ready",
          models: {
            economy: "openrouter/qwen3-coder",
            standard: "opencode/gpt-5.2-codex",
            judgment: "gpt-5.3-codex",
          },
        },
      ],
    };
  }
  if (pathname === `/api/v1/projects/${PROJECT_ID}/runs`) return { runs: [RUN] };
  if (pathname.endsWith(`/runs/${RUN.id}`)) return { run: RUN };
  if (pathname.endsWith(`/runs/${RUN.id}/events`)) {
    return { events: EVENTS, next_after: EVENTS.at(-1)!.seq };
  }
  if (pathname === `/api/v1/projects/${PROJECT_ID}/workflows`) {
    return {
      workflows: [
        {
          workflow_id: WORKFLOW.workflow_id,
          latest_revision: WORKFLOW.revision,
          latest_digest: WORKFLOW_DIGEST,
          active: true,
        },
      ],
    };
  }
  if (pathname === `/api/v1/projects/${PROJECT_ID}/workflows/templates`) {
    return { templates: listWorkflowTemplates() };
  }
  if (pathname === `/api/v1/projects/${PROJECT_ID}/workflows/${WORKFLOW.workflow_id}`) {
    return { workflow: workflowRecord() };
  }
  return null;
}

function staticResponse(pathname: string): { body: Buffer; contentType: string } | null {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = resolve(STATIC_ROOT, relative);
  if (target !== STATIC_ROOT && !target.startsWith(`${STATIC_ROOT}${sep}`)) return null;
  if (!existsSync(target)) return null;
  const contentType = MIME_TYPES.get(extname(target)) ?? "application/octet-stream";
  let body = readFileSync(target);
  if (target === resolve(STATIC_ROOT, "index.html")) {
    body = Buffer.from(
      body.toString("utf8").replace("</head>", `${CAPTURE_STYLE}${CAPTURE_PROBE}</head>`),
    );
  }
  return { body, contentType };
}

function createFixtureServer(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/v1/")) {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        json(response, { error: { message: "unauthorized" } }, 401);
        return;
      }
      if (url.pathname.endsWith("/events/stream")) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.end();
        return;
      }
      const value = apiResponse(url.pathname);
      if (value) json(response, value);
      else json(response, { error: { message: "fixture route not found" } }, 404);
      return;
    }
    const file = staticResponse(url.pathname);
    if (!file) {
      response.writeHead(404).end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": file.contentType,
    });
    response.end(file.body);
  });
}

function browserPath(): string {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome or Chromium is required to capture operator screenshots");
  return found;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("Usage: capture-docs-screenshots.js [--check]");
  const check = args[0] === "--check";
  let temporary: string | undefined;
  const server = createFixtureServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture server address unavailable");
    const url = `http://127.0.0.1:${address.port}/#token=${TOKEN}`;
    const browser = browserPath();
    if (check) temporary = mkdtempSync(resolve(tmpdir(), "rae-operator-browser-check-"));
    const output = temporary ?? SCREENSHOT_ROOT;
    await captureViewport(
      browser,
      url,
      resolve(output, "evidence-dossier-desktop.png"),
      1360,
      1600,
    );
    await captureViewport(browser, url, resolve(output, "evidence-dossier-mobile.png"), 390, 1400);
  } finally {
    try {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  }
}

await main();
