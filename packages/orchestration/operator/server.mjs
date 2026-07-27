#!/usr/bin/env node
/** Serves the authenticated loopback-only operator API and static console. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunController } from "./lib/control.mjs";
import {
  createProjectRegistry,
  createSessionToken,
  findProject,
  isAuthorized,
  positiveInteger,
  readJsonBody,
  validateLoopbackRequest,
  validateRunId,
} from "./lib/security.mjs";
import { discoverRuns, locateRun, paginatedEvents, publicRun } from "./lib/runs.mjs";
import { assertSupportedNodeRuntime } from "../scripts/lib/node-runtime.mjs";

assertSupportedNodeRuntime();

const operatorRoot = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(operatorRoot, "static");
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const STATIC_ROOT_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
]);
const API_PREFIX = "/api/v1";

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function errorResponse(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? "internal server error" : error.message;
  sendJson(res, status, { error: { status, message } });
}

function splitPath(pathname) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw Object.assign(new Error("invalid request path"), { status: 400 });
  }
}

function requireMethod(req, method) {
  if (req.method !== method) throw Object.assign(new Error("method not allowed"), { status: 405 });
}

function resolveStaticPath(pathname) {
  const rootAlias = STATIC_ROOT_FILES.get(pathname);
  if (rootAlias) return resolve(staticRoot, rootAlias);
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.includes("..")) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_-]*\.(css|js|html)$/.test(relative)) return null;
  const candidate = resolve(staticRoot, relative);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}/`)) return null;
  return candidate;
}

function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    errorResponse(res, Object.assign(new Error("method not allowed"), { status: 405 }));
    return;
  }
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    errorResponse(res, Object.assign(new Error("not found"), { status: 404 }));
    return;
  }
  let body;
  try {
    body = readFileSync(filePath);
  } catch {
    errorResponse(res, Object.assign(new Error("not found"), { status: 404 }));
    return;
  }
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "content-length": body.length,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function streamEvents(req, res, run, after) {
  let cursor = after;
  let closed = false;
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/x-ndjson; charset=utf-8",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
  });
  const writeAvailable = () => {
    if (closed) return;
    try {
      const page = paginatedEvents(run, { after: cursor, limit: 200 });
      for (const event of page.events) res.write(`${JSON.stringify(event)}\n`);
      cursor = page.next_after;
    } catch {
      res.write(`${JSON.stringify({ event: "stream_error", status: "unavailable" })}\n`);
      finish();
    }
  };
  const interval = setInterval(writeAvailable, 750);
  const timeout = setTimeout(() => finish(), 15_000);
  interval.unref?.();
  timeout.unref?.();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearTimeout(timeout);
    res.end();
  };
  req.on("close", finish);
  writeAvailable();
}

async function routeApi(req, res, url, context) {
  const { projects, token, controller, host, origin } = context;
  const loopback = validateLoopbackRequest(req, {
    host,
    origin,
    requireOrigin: !["GET", "HEAD"].includes(req.method),
  });
  if (!loopback.ok) {
    sendJson(res, loopback.status, { error: { status: loopback.status, message: loopback.error } });
    return;
  }
  if (!isAuthorized(req.headers.authorization, token)) {
    sendJson(res, 401, { error: { status: 401, message: "bearer authentication required" } });
    return;
  }

  const parts = splitPath(url.pathname);
  if (parts[0] !== "api" || parts[1] !== "v1")
    throw Object.assign(new Error("not found"), { status: 404 });
  if (parts.length === 3 && parts[2] === "projects") {
    requireMethod(req, "GET");
    sendJson(res, 200, {
      projects: projects.map(({ id, label }) => ({ id, label })),
      active_run_id: controller.refreshOwnership(),
    });
    return;
  }
  if (parts[2] !== "projects" || !parts[3])
    throw Object.assign(new Error("not found"), { status: 404 });
  const project = findProject(projects, parts[3]);
  if (!project) throw Object.assign(new Error("project not found"), { status: 404 });
  if (parts[4] !== "runs") throw Object.assign(new Error("not found"), { status: 404 });

  if (parts.length === 5) {
    if (req.method === "GET") {
      const cursor = positiveInteger(url.searchParams.get("cursor"), 0, 1_000_000);
      const limit = positiveInteger(url.searchParams.get("limit"), 30, 100);
      controller.refreshOwnership();
      const all = discoverRuns(project);
      const page = all
        .slice(cursor, cursor + limit)
        .map((run) => publicRun(run, controller.ownedRunId));
      sendJson(res, 200, {
        runs: page,
        next_cursor: cursor + page.length < all.length ? cursor + page.length : null,
      });
      return;
    }
    requireMethod(req, "POST");
    sendJson(res, 202, controller.start(project, await readJsonBody(req)));
    return;
  }

  const runId = validateRunId(parts[5]);
  if (parts.length === 6) {
    requireMethod(req, "GET");
    controller.refreshOwnership();
    sendJson(res, 200, { run: publicRun(locateRun(project, runId), controller.ownedRunId) });
    return;
  }

  const action = parts[6];
  if (action === "events" && parts.length === 7) {
    requireMethod(req, "GET");
    const after = positiveInteger(url.searchParams.get("after"), 0, 10_000_000);
    const limit = positiveInteger(url.searchParams.get("limit"), 100, 200);
    sendJson(res, 200, paginatedEvents(locateRun(project, runId), { after, limit }));
    return;
  }
  if (action === "events" && parts[7] === "stream" && parts.length === 8) {
    requireMethod(req, "GET");
    const after = positiveInteger(url.searchParams.get("after"), 0, 10_000_000);
    streamEvents(req, res, locateRun(project, runId), after);
    return;
  }
  requireMethod(req, "POST");
  if (parts.length !== 7) throw Object.assign(new Error("not found"), { status: 404 });
  const body = await readJsonBody(req);
  if (action === "stop") {
    sendJson(res, 200, { control: controller.stop(project, runId) });
  } else if (action === "resume") {
    sendJson(res, 202, controller.resume(project, runId));
  } else if (action === "interrupt") {
    sendJson(res, 202, controller.interrupt(project, runId, body));
  } else if (action === "checkpoint-decision") {
    sendJson(res, 200, { checkpoint: controller.decideCheckpoint(project, runId, body) });
  } else if (action === "cleanup") {
    sendJson(res, 202, controller.cleanup(project, runId, body));
  } else {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
}

export async function handleOperatorRequest(req, res, context) {
  try {
    const url = new URL(req.url, context.origin);
    if (url.pathname.startsWith(API_PREFIX)) {
      await routeApi(req, res, url, context);
    } else {
      const loopback = validateLoopbackRequest(req, context);
      if (!loopback.ok) {
        errorResponse(res, Object.assign(new Error(loopback.error), { status: loopback.status }));
        return;
      }
      serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    if (!res.headersSent) errorResponse(res, error);
    else res.end();
  }
}

export function createOperatorServer({
  projects,
  token = createSessionToken(),
  controller = new RunController(),
}) {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error("projects are required");
  const server = createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      errorResponse(res, new Error("server address unavailable"));
      return;
    }
    const host = `127.0.0.1:${address.port}`;
    await handleOperatorRequest(req, res, {
      projects,
      token,
      controller,
      host,
      origin: `http://${host}`,
    });
  });
  return { server, token, controller };
}

function parseCli(argv) {
  const paths = [];
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      const value = argv[index + 1];
      if (!value) throw new Error("--project requires a path");
      paths.push(value);
      index += 1;
    } else if (arg === "--port") {
      port = Number(argv[index + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid --port");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node operator/server.mjs --project <git-root> [--project <git-root>] [--port 0]\n",
      );
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { projects: createProjectRegistry(paths), port };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (!options) return;
  const instance = createOperatorServer({ projects: options.projects });
  await new Promise((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(options.port, "127.0.0.1", resolveListen);
  });
  const address = instance.server.address();
  process.stdout.write(
    `RAE operator console: http://127.0.0.1:${address.port}/#token=${instance.token}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
