/** Captures operator documentation screenshots from current UI code and sanitized fixtures. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import {
  compileWorkflowTemplate,
  listWorkflowTemplates,
} from "../../scripts/pipeline/lib/workflow-designer.mjs";
import { workflowDigest } from "../../scripts/pipeline/lib/workflow-contract.mjs";

const OPERATOR_ROOT = resolve(import.meta.dirname, "..");
const STATIC_ROOT = resolve(OPERATOR_ROOT, "static");
const SCREENSHOT_ROOT = resolve(OPERATOR_ROOT, "docs", "screenshots");
const TOKEN = "rae-docs-capture-token";
const PROJECT_ID = "project_docs_fixture";
const WORKFLOW = compileWorkflowTemplate("bounded-until-dry-loop", {
  workflow_id: "release-discovery",
  revision: 3,
  title: "Bounded release discovery",
  max_repair_rounds: 3,
});
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
    .ident, .ledger, .run-heading, .phase-region, .proof-band, .hold, .detail { display: none !important; }
    .page { padding-top: 1rem; }
    .workflow-editor { margin-top: 0; }
    .workflow-structure { max-height: 17rem; }
    @media (max-width: 900px) {
      .page { padding-top: .75rem; }
      .workflow-editor { padding: 1rem; }
    }
  </style>
`;
const CAPTURE_PROBE = `
  <script>
    window.addEventListener("error", (event) => {
      document.documentElement.dataset.captureError = event.message || "browser error";
    });
    window.addEventListener("unhandledrejection", (event) => {
      document.documentElement.dataset.captureError = event.reason?.message || "unhandled rejection";
    });
    window.addEventListener("load", () => window.setTimeout(() => {
      document.getElementById("workflow-view-loop")?.click();
      document.getElementById("workflow-view-graph")?.click();
      const connected = document.getElementById("connection-status")?.dataset.state === "connected";
      const nodes = document.querySelectorAll("#workflow-graph-content .workflow-node").length;
      const selected = document.getElementById("workflow-view-graph")?.getAttribute("aria-selected");
      document.documentElement.dataset.captureReady = String(connected && nodes > 0 && selected === "true");
    }, 100));
  </script>
`;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function instance(nodeId, status, attempt, executionTier, extra = {}) {
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

function event(seq, phase, name, status, artifactRef) {
  return {
    seq,
    event: name,
    phase,
    status,
    artifact_ref: artifactRef,
    ts: `2026-08-05T08:${String(35 + seq * 3).padStart(2, "0")}:00.000Z`,
  };
}

function json(response, value, status = 200) {
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

function apiResponse(pathname) {
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
  if (pathname.endsWith(`/runs/${RUN.id}/events`)) {
    return { events: EVENTS, next_after: EVENTS.at(-1).seq };
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

function staticResponse(pathname) {
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

function createFixtureServer() {
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

function browserPath() {
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

function capture(browser, url, filename, width, height) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--force-device-scale-factor=1",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=1800",
        `--window-size=${width},${height}`,
        `--screenshot=${resolve(SCREENSHOT_ROOT, filename)}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`browser capture failed (${code}): ${errorOutput.trim()}`));
    });
  });
}

function probe(browser, url) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=1800",
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`browser probe failed (${code}): ${errorOutput.trim()}`));
        return;
      }
      if (!output.includes('data-capture-ready="true"')) {
        reject(new Error("operator fixture did not reach the connected Graph view"));
        return;
      }
      if (output.includes("data-capture-error=")) {
        reject(new Error("operator fixture reported a browser error"));
        return;
      }
      resolvePromise();
    });
  });
}

async function main() {
  const server = createFixtureServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/#token=${TOKEN}`;
    const browser = browserPath();
    await probe(browser, url);
    await capture(browser, url, "evidence-dossier-desktop.png", 1360, 1600);
    await capture(browser, url, "evidence-dossier-mobile.png", 390, 1400);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

await main();
