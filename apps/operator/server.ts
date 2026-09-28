#!/usr/bin/env node
/** Serves the authenticated loopback-only operator API and static console. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunController } from "./lib/control.js";
import {
  createProjectRegistry,
  createSessionToken,
  findProject,
  isAuthorized,
  positiveInteger,
  readJsonBody,
  validateLoopbackRequest,
  validateRunId,
} from "./lib/security.js";
import {
  discoverRuns,
  locateRun,
  paginatedEvents,
  publicRun,
  publicRunSummary,
  projectRunDetails,
  RunCatalog,
} from "./lib/runs.js";
import type { InternalRun } from "./lib/runs.js";
import {
  analyzeWorkflowFor,
  assertRegistryMethod,
  compileWorkflowTemplateFor,
  workflowRegistryFor,
  workflowTemplates,
} from "./lib/workflows.js";
import { OperatorProfiles, loadOperatorProfiles } from "./lib/profiles.js";
import { WorkflowProposalJobs } from "./lib/proposals.js";
import { createRemoteOperatorProxy, MAX_REMOTE_RESPONSE_BYTES } from "./lib/remote.js";
import type { RemoteForwardResult, RemoteProxy } from "./lib/remote.js";
import { EventTailHub } from "./lib/tail.js";
import type { TailDelivery, TailEvent, TailRun, TailSubscription } from "./lib/tail.js";
import type { OperatorProject } from "./lib/security.js";
import { assertSupportedNodeRuntime } from "@rae/engine";

assertSupportedNodeRuntime();

const operatorRoot = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(operatorRoot, "static");
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};
const STATIC_ROOT_FILES = new Map<string, string>([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/favicon.svg", "favicon.svg"],
]);
const API_PREFIX = "/api/v1";

type JsonRecord = Record<string, unknown>;
type HttpError = Error & { status?: number };
type WorkflowRegistry = Record<string, unknown>;
interface OperatorContext {
  projects: OperatorProject[];
  token: string;
  controller: RunController;
  profiles: OperatorProfiles;
  proposalJobs: WorkflowProposalJobs;
  runCatalog: RunCatalog;
  tailHub: EventTailHub;
  remote: RemoteProxy | null;
  host: string;
  origin: string;
  workflowRegistry?: WorkflowRegistry;
}
interface OperatorServerOptions {
  projects?: OperatorProject[];
  token?: string;
  controller?: RunController;
  remoteUrl?: string | null;
  tokenFile?: string | null;
  fetchImpl?: typeof globalThis.fetch;
  profiles?: OperatorProfiles;
  proposalJobs?: WorkflowProposalJobs;
  runCatalog?: RunCatalog;
  tailHub?: EventTailHub;
}
interface CliOptions {
  projects: OperatorProject[];
  port: number;
  remoteUrl: string | null;
  tokenFile: string | null;
  executionProfiles: string[];
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

async function sendRemoteResponse(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: RemoteForwardResult,
): Promise<void> {
  res.writeHead(upstream.status, {
    ...securityHeaders(),
    "content-type": upstream.contentType,
    ...(upstream.body ? { "content-length": upstream.body.length } : {}),
  });
  if (!upstream.stream) {
    res.end(upstream.body);
    return;
  }
  const reader = upstream.stream.getReader();
  let size = 0;
  let closed = false;
  const finish = async () => {
    if (closed) return;
    closed = true;
    await reader.cancel().catch(() => {});
    res.end();
  };
  const timeout = setTimeout(() => void finish(), 15_000);
  timeout.unref?.();
  req.once("close", () => void finish());
  try {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REMOTE_RESPONSE_BYTES) break;
      res.write(Buffer.from(value));
    }
  } finally {
    clearTimeout(timeout);
    await finish();
  }
}

function errorResponse(res: ServerResponse, error: unknown): void {
  const candidate = (error instanceof Error ? error : new Error(String(error))) as HttpError;
  const status = Number.isInteger(candidate.status) ? candidate.status! : 500;
  const message = status >= 500 ? "internal server error" : candidate.message;
  sendJson(res, status, { error: { status, message } });
}

function splitPath(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw Object.assign(new Error("invalid request path"), { status: 400 });
  }
}

function requireMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw Object.assign(new Error("method not allowed"), { status: 405 });
}

function resolveStaticPath(pathname: string): string | null {
  const rootAlias = STATIC_ROOT_FILES.get(pathname);
  if (rootAlias) return resolve(staticRoot, rootAlias);
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.includes("..")) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_-]*\.(css|js|html|woff2)$/.test(relative)) return null;
  const candidate = resolve(staticRoot, relative);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}/`)) return null;
  return candidate;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (!["GET", "HEAD"].includes(req.method ?? "")) {
    errorResponse(res, Object.assign(new Error("method not allowed"), { status: 405 }));
    return;
  }
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    errorResponse(res, Object.assign(new Error("not found"), { status: 404 }));
    return;
  }
  let body: Buffer;
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

interface TailWriter {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

/** Writes one tail page and reports the exact accepted cursor even under backpressure. */
export function writeTailEvents(
  response: TailWriter,
  events: readonly TailEvent[],
  fallbackAfter: number,
  resume: () => void,
): TailDelivery {
  let acceptedThrough = fallbackAfter;
  for (const event of events) {
    const ready = response.write(`${JSON.stringify(event)}\n`);
    acceptedThrough = event.seq;
    if (!ready) {
      response.once("drain", resume);
      return { acceptedThrough, pause: true };
    }
  }
  return { acceptedThrough };
}

function streamEvents(
  _req: IncomingMessage,
  res: ServerResponse,
  run: TailRun,
  after: number,
  tailHub: EventTailHub,
): void {
  let closed = false;
  let subscription: TailSubscription | null = null;
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/x-ndjson; charset=utf-8",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    subscription?.close();
    res.end();
  };
  subscription = tailHub.subscribe(
    run,
    after,
    (events) => {
      if (closed) return { acceptedThrough: after };
      return writeTailEvents(res, events, after, () => subscription?.resume());
    },
    () => {
      if (!closed)
        res.write(`${JSON.stringify({ event: "stream_error", status: "unavailable" })}\n`);
      finish();
    },
  );
  const timeout = setTimeout(finish, 15_000);
  timeout.unref?.();
  res.once("close", finish);
}

async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: OperatorContext,
): Promise<void> {
  const { projects, token, controller, host, origin, remote } = context;
  const loopback = validateLoopbackRequest(req, {
    host,
    origin,
    requireOrigin: !["GET", "HEAD"].includes(req.method ?? ""),
  });
  if (!loopback.ok) {
    const status = loopback.status ?? 403;
    sendJson(res, status, { error: { status, message: loopback.error } });
    return;
  }
  if (!isAuthorized(req.headers.authorization, token)) {
    sendJson(res, 401, { error: { status: 401, message: "bearer authentication required" } });
    return;
  }
  if (remote) {
    const upstream = await remote.forward(req, url);
    await sendRemoteResponse(req, res, upstream);
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
  if (parts[4] === "execution-profiles" && parts.length === 5) {
    requireMethod(req, "GET");
    sendJson(res, 200, { profiles: (context.profiles ?? new OperatorProfiles()).list() });
    return;
  }
  if (parts[4] === "workflows") {
    await routeWorkflows(req, res, url, context, project, parts.slice(5));
    return;
  }
  if (parts[4] !== "runs") throw Object.assign(new Error("not found"), { status: 404 });

  if (parts.length === 5) {
    if (req.method === "GET") {
      const limit = positiveInteger(url.searchParams.get("limit"), 30, 100);
      controller.refreshOwnership();
      const view = url.searchParams.get("view");
      if (view !== null && view !== "summary")
        throw Object.assign(new Error("invalid run view"), { status: 400 });
      const page = await context.runCatalog.page(project, {
        cursor: url.searchParams.get("cursor"),
        limit,
        view: view ?? "detail",
      });
      sendJson(res, 200, {
        ...page,
        runs:
          view === "summary"
            ? page.runs
            : page.runs.map((run) => publicRun(run as InternalRun, controller.ownedRunId)),
      });
      return;
    }
    requireMethod(req, "POST");
    const body = await readJsonBody(req);
    const executionProfile = (context.profiles ?? new OperatorProfiles()).resolve(
      body.execution_profile_id,
    );
    sendJson(res, 202, controller.start(project, body, executionProfile));
    return;
  }

  const runId = validateRunId(parts[5]);
  if (parts.length === 6) {
    requireMethod(req, "GET");
    controller.refreshOwnership();
    sendJson(res, 200, {
      run: publicRun(await context.runCatalog.locate(project, runId), controller.ownedRunId),
    });
    return;
  }

  const action = parts[6];
  if (action === "events" && parts.length === 7) {
    requireMethod(req, "GET");
    const after = positiveInteger(url.searchParams.get("after"), 0, 10_000_000);
    const limit = positiveInteger(url.searchParams.get("limit"), 100, 200);
    sendJson(
      res,
      200,
      paginatedEvents(await context.runCatalog.locate(project, runId, { view: "summary" }), {
        after,
        limit,
      }),
    );
    return;
  }
  if (action === "events" && parts[7] === "stream" && parts.length === 8) {
    requireMethod(req, "GET");
    const after = positiveInteger(url.searchParams.get("after"), 0, 10_000_000);
    streamEvents(
      req,
      res,
      await context.runCatalog.locate(project, runId, { view: "summary" }),
      after,
      context.tailHub,
    );
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

function projectHasActiveRun(project: OperatorProject): boolean {
  try {
    return discoverRuns(project, { view: "summary" }).some(
      (run) =>
        run.runtime_active || ["running", "waiting", "stop-requested"].includes(run.status ?? ""),
    );
  } catch {
    // A missing or unreadable runtime directory is not an active execution.
    return false;
  }
}

function workflowMutationAllowed(project: OperatorProject, controller: RunController): void {
  controller.refreshOwnership();
  if (controller.ownedRunId || projectHasActiveRun(project)) {
    throw Object.assign(new Error("workflow revisions are immutable while a run is active"), {
      status: 409,
    });
  }
}

async function routeWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: OperatorContext,
  project: OperatorProject,
  tail: string[],
): Promise<void> {
  const registry = context.workflowRegistry ?? (await workflowRegistryFor(project));
  if (tail.length === 0) {
    requireMethod(req, "GET");
    sendJson(res, 200, { workflows: await assertRegistryMethod(registry, "list")() });
    return;
  }
  if (tail[0] === "templates" && tail.length === 1) {
    if (req.method === "GET") {
      sendJson(res, 200, { templates: await workflowTemplates() });
      return;
    }
    requireMethod(req, "POST");
    const body = await readJsonBody(req);
    const allowed = new Set(["template_id", "workflow_id", "revision", "title"]);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.has(key))
    ) {
      throw Object.assign(new Error("invalid workflow template request"), { status: 400 });
    }
    sendJson(res, 200, {
      workflow: await compileWorkflowTemplateFor(String(body.template_id ?? ""), {
        workflow_id: body.workflow_id,
        revision: body.revision,
        ...(body.title ? { title: body.title } : {}),
      }),
    });
    return;
  }
  const workflowId = tail[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workflowId)) {
    throw Object.assign(new Error("invalid workflow id"), { status: 400 });
  }
  if (tail.length === 1) {
    requireMethod(req, "GET");
    sendJson(res, 200, { workflow: await assertRegistryMethod(registry, "show")(workflowId) });
    return;
  }
  if (tail[1] === "analysis" && tail.length === 2) {
    requireMethod(req, "POST");
    const body = await readJsonBody(req);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "workflow")
    ) {
      throw Object.assign(new Error("analysis accepts only a workflow object"), { status: 400 });
    }
    sendJson(res, 200, await analyzeWorkflowFor(body.workflow));
    return;
  }
  if (tail[1] === "proposals" && tail.length === 2) {
    requireMethod(req, "POST");
    const body = await readJsonBody(req);
    const executionProfile = (context.profiles ?? new OperatorProfiles()).resolve(
      body.execution_profile_id,
    );
    sendJson(
      res,
      202,
      (context.proposalJobs ?? new WorkflowProposalJobs()).submit({
        project,
        workflowId,
        body,
        executionProfile,
      }),
    );
    return;
  }
  if (tail[1] === "proposals" && tail.length === 3) {
    requireMethod(req, "GET");
    if (!/^proposal-[a-f0-9-]{36}$/.test(tail[2])) {
      throw Object.assign(new Error("invalid proposal job id"), { status: 400 });
    }
    sendJson(res, 200, {
      proposal: (context.proposalJobs ?? new WorkflowProposalJobs()).get(tail[2], workflowId),
    });
    return;
  }
  if (tail[1] === "drafts" && tail.length === 2) {
    requireMethod(req, "POST");
    workflowMutationAllowed(project, context.controller);
    sendJson(res, 201, {
      revision: await assertRegistryMethod(registry, "draft")(workflowId, await readJsonBody(req)),
    });
    return;
  }
  if (tail[1] === "diff" && tail.length === 2) {
    requireMethod(req, "GET");
    sendJson(res, 200, {
      diff: await assertRegistryMethod(registry, "diff")(
        workflowId,
        Object.fromEntries(url.searchParams),
      ),
    });
    return;
  }
  if (tail[1] === "revisions" && tail[3] === "validate" && tail.length === 4) {
    requireMethod(req, "POST");
    workflowMutationAllowed(project, context.controller);
    sendJson(res, 200, {
      validation: await assertRegistryMethod(registry, "validate")(
        workflowId,
        tail[2],
        await readJsonBody(req),
      ),
    });
    return;
  }
  if (tail[1] === "revisions" && tail[3] === "activate" && tail.length === 4) {
    requireMethod(req, "POST");
    workflowMutationAllowed(project, context.controller);
    sendJson(res, 200, {
      activation: await assertRegistryMethod(registry, "activate")(
        workflowId,
        tail[2],
        await readJsonBody(req),
      ),
    });
    return;
  }
  throw Object.assign(new Error("not found"), { status: 404 });
}

export async function handleOperatorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: OperatorContext,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", context.origin);
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
  projects = [],
  token = createSessionToken(),
  controller = new RunController(),
  remoteUrl = null,
  tokenFile = null,
  fetchImpl,
  profiles = new OperatorProfiles(),
  proposalJobs = new WorkflowProposalJobs(),
  runCatalog = new RunCatalog(),
  tailHub = new EventTailHub(),
}: OperatorServerOptions): { server: Server; token: string; controller: RunController } {
  if (!Array.isArray(projects)) throw new Error("projects must be an array");
  if (remoteUrl && projects.length)
    throw new Error("--remote-url cannot be combined with --project");
  if (!remoteUrl && tokenFile) throw new Error("--token-file requires --remote-url");
  if (!remoteUrl && projects.length === 0) throw new Error("projects are required");
  if (!profiles || typeof profiles.list !== "function" || typeof profiles.resolve !== "function") {
    throw new Error("profiles must be an OperatorProfiles instance");
  }
  const remote = remoteUrl
    ? createRemoteOperatorProxy({ remoteUrl, tokenFile, ...(fetchImpl ? { fetchImpl } : {}) })
    : null;
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
      profiles,
      proposalJobs,
      runCatalog,
      tailHub,
      remote,
      host,
      origin: `http://${host}`,
    });
  });
  server.once("close", () => runCatalog.close());
  return { server, token, controller };
}

function parseCli(argv: string[]): CliOptions | null {
  const paths: string[] = [];
  let port = 0;
  let remoteUrl = null;
  let tokenFile = null;
  const executionProfiles: string[] = [];
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
    } else if (arg === "--remote-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--remote-url requires a URL");
      remoteUrl = value;
      index += 1;
    } else if (arg === "--token-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--token-file requires a path");
      tokenFile = value;
      index += 1;
    } else if (arg === "--execution-profile") {
      const value = argv[index + 1];
      if (!value) throw new Error("--execution-profile requires a path");
      executionProfiles.push(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run rae -- operator (--project <git-root> [--project <git-root>] | --remote-url <https-url> --token-file <owner-only-file>) [--execution-profile <file>] [--port 0]\n",
      );
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (remoteUrl && paths.length) throw new Error("--remote-url cannot be combined with --project");
  if (remoteUrl && !tokenFile) throw new Error("--token-file is required with --remote-url");
  if (!remoteUrl && tokenFile) throw new Error("--token-file requires --remote-url");
  return {
    projects: remoteUrl ? [] : createProjectRegistry(paths),
    port,
    remoteUrl,
    tokenFile,
    executionProfiles,
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (!options) return;
  const profiles = await loadOperatorProfiles(options.executionProfiles);
  const instance = createOperatorServer({ ...options, profiles });
  await new Promise<void>((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  const address = instance.server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  process.stdout.write(
    `RAE operator console: http://127.0.0.1:${address.port}/#token=${instance.token}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
