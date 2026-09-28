/** Purpose: raw Node HTTP implementation of the experimental /api/v2 surface. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  authorizedProjects,
  PLATFORM_SCOPES,
  requireProject,
  requireScope,
  requireWorkerIdentity,
} from "./auth.js";
import { handleStreamableMcp } from "./mcp.js";
import { Metrics, traceparent } from "./observability.js";

const uuid = z.string().uuid();
const object = z.record(z.string(), z.unknown());
const runInput = z.object({
  projectId: z.string(),
  revision: z.object({ digest: z.string().length(64), definition: object }),
  nodes: z
    .array(
      z.object({
        key: z.string(),
        payload: object.optional(),
        access: z.enum(["read", "write"]).default("read"),
      }),
    )
    .max(MAX_RUN_NODES),
  request: object.default({}),
  repositoryDigest: z.string().length(64).optional(),
  worktreeDigest: z.string().length(64).optional(),
});

const body = readJsonBody;

function send(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(value));
}

function closeFailedResponse(res: ServerResponse) {
  if (!res.destroyed) res.destroy();
}

function key(req: IncomingMessage) {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value))
    throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
  return value;
}

const EVENT_PAGE_SIZE = 100;

function writeWithBackpressure(
  res: ServerResponse,
  chunk: string,
  signal: AbortSignal | null = null,
) {
  if (signal?.aborted) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      signal?.removeEventListener("abort", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    signal?.addEventListener("abort", onClose, { once: true });
  });
}

function waitForPoll(res: ServerResponse, timeoutMs: number, signal: AbortSignal | null = null) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      res.off("close", onClose);
      signal?.removeEventListener("abort", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    res.once("close", onClose);
    signal?.addEventListener("abort", onClose, { once: true });
  });
}

export async function streamRunEvents(
  _req: IncomingMessage,
  res: ServerResponse,
  store: StreamStore,
  runId: string,
  fromId: string | number = 0,
  signal: AbortSignal | null = null,
) {
  let cursor = streamEventCursor(fromId);
  const read = () =>
    pageRunEvents(store, runId, {
      cursor: encodeEventCursor(runId, cursor),
      limit: EVENT_PAGE_SIZE,
      encoding: {
        eventBytes: (serialized) => Buffer.byteLength(serialized) + 64,
        emptyPageBytes: () => 0,
      },
    });
  let page = await read();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  res.once("close", onClose);
  const deadline = Date.now() + 30 * 60 * 1000;
  try {
    while (!closed && !signal?.aborted && Date.now() < deadline) {
      for (const event of page.events) {
        const eventId = streamEventCursor(event.id);
        if (
          !(await writeWithBackpressure(
            res,
            `id: ${eventId}\nevent: rae-event\ndata: ${JSON.stringify(event)}\n\n`,
            signal,
          ))
        ) {
          closed = true;
          break;
        }
        cursor = eventId;
      }
      if (closed || signal?.aborted) break;
      if (!page.nextCursor) {
        const run = await store.getRun(runId);
        if (!run || ["succeeded", "failed", "cancelled"].includes(run.state)) {
          page = await read();
          if (!page.events.length) break;
          continue;
        }
        if (await waitForPoll(res, 1000, signal)) break;
      }
      page = await read();
    }
  } catch (error) {
    if (error instanceof EventPageError && !closed && !signal?.aborted)
      await writeWithBackpressure(
        res,
        `event: error\ndata: ${JSON.stringify({ error: error.code, message: error.message })}\n\n`,
        signal,
      );
    else {
      closed = true;
      res.destroy();
      throw error;
    }
  } finally {
    res.off("close", onClose);
    if (!closed && !res.writableEnded) res.end();
  }
}

/** Handles one authenticated platform request with its explicit dependency boundary. */
export async function handlePlatformRequest(
  req: IncomingMessage,
  res: ServerResponse,
  {
    store,
    authenticate,
    artifactService = null,
    logger = () => {},
    metrics = new Metrics(),
    oidc = null,
    resourceBaseUrl = null,
    allowedHosts = [],
    activeEventStreams = null,
    ready = () => false,
  }: PlatformDependencies,
) {
  const started = Date.now();
  const span = traceparent(req.headers.traceparent);
  res.setHeader("traceparent", span);
  try {
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && route === "/healthz")
      return send(res, 200, { status: "ok", experimental: true });
    if (req.method === "GET" && route === "/readyz")
      return send(res, ready() ? 200 : 503, { status: ready() ? "ready" : "unavailable" });
    if (route === "/metrics") return send(res, 404, { error: "not found" });
    if (
      req.method === "GET" &&
      (route === "/.well-known/oauth-protected-resource" ||
        route === "/.well-known/oauth-protected-resource/mcp")
    ) {
      return send(res, 200, {
        resource: `${resourceBaseUrl}/mcp`,
        authorization_servers: oidc ? [oidc.issuer] : [],
        scopes_supported: PLATFORM_SCOPES,
      });
    }
    if (
      route === "/mcp" &&
      allowedHosts.length &&
      !allowedHosts.includes(String(req.headers.host || "").replace(/:\d+$/, ""))
    )
      return send(res, 403, { error: "invalid Host header" });

    const principal = await authenticate(req.headers.authorization);
    const input = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await body(req) : {};

    if (req.method === "POST" && route === "/api/v2/revisions") {
      requireScope(principal, "rae.policy.write");
      const value = z
        .object({
          projectId: z.string(),
          kind: z.enum(["workflow", "profile"]),
          document: object,
          digest: z.string().length(64),
        })
        .parse(input);
      requireProject(principal, value.projectId);
      return send(
        res,
        201,
        await store.uploadRevision({
          projectId: value.projectId,
          kind: value.kind,
          document: value.document,
          expectedDigest: value.digest,
          idempotencyKey: key(req),
        }),
      );
    }
    if (req.method === "POST" && /^\/api\/v2\/revisions\/[^/]+\/activate$/.test(route)) {
      requireScope(principal, "rae.policy.write");
      const value = z
        .object({
          projectId: z.string(),
          kind: z.enum(["workflow", "profile"]),
          digest: z.string().length(64),
        })
        .parse(input);
      requireProject(principal, value.projectId);
      return send(
        res,
        200,
        await store.activateRevision({
          projectId: value.projectId,
          kind: value.kind,
          revisionId: route.split("/")[4],
          expectedDigest: value.digest,
          idempotencyKey: key(req),
        }),
      );
    }
    if (req.method === "POST" && route === "/api/v2/revisions/diff") {
      requireScope(principal, "rae.policy.write");
      const value = z.object({ fromId: uuid, toId: uuid }).parse(input);
      const [from, to] = await Promise.all([
        store.getRevision(value.fromId),
        store.getRevision(value.toId),
      ]);
      if (!from || !to)
        throw Object.assign(new Error("comparable revisions not found"), { statusCode: 404 });
      requireProject(principal, from.projectId);
      requireProject(principal, to.projectId);
      if (from.projectId !== to.projectId || from.kind !== to.kind)
        throw Object.assign(new Error("comparable revisions not found"), { statusCode: 404 });
      return send(res, 200, await store.diffRevisions(value));
    }
    if (req.method === "POST" && route === "/api/v2/runs") {
      requireScope(principal, "rae.run.submit");
      const value = runInput.parse(input);
      requireProject(principal, value.projectId);
      return send(
        res,
        201,
        await store.createRun({ ...value, idempotencyKey: key(req), traceparent: span }),
      );
    }

    const match = /^\/api\/v2\/runs\/([0-9a-f-]{36})(?:\/([^/]+))?$/.exec(route);
    if (match) {
      const run = await store.getRun(match[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      requireProject(principal, run.projectId);
      if (req.method === "GET" && !match[2]) {
        requireScope(principal, "rae.run.read");
        return send(res, 200, run);
      }
      if (req.method === "GET" && match[2] === "events") {
        requireScope(principal, "rae.run.read");
        const eventUrl = new URL(req.url ?? "/", "http://localhost");
        if (eventUrl.searchParams.get("stream") === "true") {
          const stream = { response: res, abort: new AbortController() };
          activeEventStreams?.add(stream);
          try {
            return await streamRunEvents(
              req,
              res,
              store,
              run.id,
              streamEventCursor(eventUrl.searchParams.get("from")),
              stream.abort.signal,
            );
          } catch (error) {
            logger("warn", "platform event stream failed", {
              route,
              error: errorMessage(error),
              traceparent: span,
            });
            if (!res.headersSent) {
              const status = errorStatus(error);
              return send(res, status, {
                error: status === 500 ? "internal error" : errorMessage(error),
              });
            }
            closeFailedResponse(res);
            return;
          } finally {
            activeEventStreams?.delete(stream);
          }
        }
        return send(
          res,
          200,
          await store.listRunEvents(run.id, {
            cursor: eventUrl.searchParams.get("cursor"),
            limit: eventUrl.searchParams.get("limit"),
          }),
        );
      }
      if (req.method === "POST" && match[2] === "cancel") {
        requireScope(principal, "rae.run.cancel");
        return send(res, 200, await store.cancelRun({ runId: run.id, idempotencyKey: key(req) }));
      }
      if (req.method === "POST" && match[2] === "signals") {
        requireScope(principal, "rae.run.signal");
        const value = z
          .object({ kind: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), payload: object })
          .parse(input);
        const signalStarted = Date.now();
        const result = await store.signalRun({
          runId: run.id,
          ...value,
          idempotencyKey: key(req),
        });
        metrics.signalLatencySeconds = (Date.now() - signalStarted) / 1000;
        return send(res, 201, result);
      }
      if (req.method === "POST" && match[2] === "rebind") {
        requireScope(principal, "rae.run.cancel");
        const value = z
          .object({
            workerId: z.string(),
            repositoryDigest: z.string().length(64),
            worktreeDigest: z.string().length(64),
          })
          .parse(input);
        return send(
          res,
          200,
          await store.rebindRun({ runId: run.id, ...value, idempotencyKey: key(req) }),
        );
      }
    }

    if (req.method === "POST" && route === "/api/v2/workers/register") {
      requireScope(principal, "rae.work.claim");
      const value = z
        .object({
          workerId: z.string(),
          repositoryDigest: z.string().length(64),
          worktreeDigest: z.string().length(64),
          capabilities: object.default({}),
        })
        .parse(input);
      requireWorkerIdentity(principal, value.workerId);
      return send(
        res,
        201,
        await store.registerWorker({
          ...value,
          projects: authorizedProjects(principal),
          idempotencyKey: key(req),
        }),
      );
    }
    if (req.method === "POST" && route === "/api/v2/workers/claim") {
      requireScope(principal, "rae.work.claim");
      const value = z
        .object({ workerId: z.string(), longPollSeconds: z.number().min(0).max(25).default(0) })
        .parse(input);
      requireWorkerIdentity(principal, value.workerId);
      const claim = await store.claim({
        ...value,
        projects: authorizedProjects(principal),
        idempotencyKey: key(req),
      });
      if (claim) metrics.leaseClaims += 1;
      return send(res, 200, { claim });
    }
    if (req.method === "POST" && /^\/api\/v2\/workers\/(heartbeat|report|failure)$/.test(route)) {
      const action = route.split("/").at(-1);
      requireScope(principal, action === "heartbeat" ? "rae.work.claim" : "rae.work.report");
      const value = z
        .object({
          workerId: z.string(),
          nodeId: uuid,
          fence: z.number().int().positive(),
          result: object.default({}),
        })
        .parse(input);
      requireWorkerIdentity(principal, value.workerId);
      const idempotencyKey = key(req);
      const result =
        action === "heartbeat"
          ? await store.heartbeat({ ...value, projects: authorizedProjects(principal) })
          : await store.report({
              ...value,
              projects: authorizedProjects(principal),
              idempotencyKey,
              outcome: action === "report" ? "succeeded" : "failed",
            });
      if (action !== "heartbeat") metrics.observeAttempt(value.result);
      return send(res, 200, result);
    }
    if (req.method === "POST" && route === "/api/v2/artifacts/reserve" && artifactService) {
      requireScope(principal, "rae.work.report");
      const value = z
        .object({
          workerId: z.string(),
          nodeId: uuid,
          fence: z.number().int(),
          sha256: z.string().length(64),
          sizeBytes: z.number().int().min(0),
          contentType: z.string().optional(),
        })
        .parse(input);
      requireWorkerIdentity(principal, value.workerId);
      key(req);
      return send(
        res,
        201,
        await artifactService.reserve({ ...value, projects: authorizedProjects(principal) }),
      );
    }
    if (req.method === "POST" && route === "/api/v2/artifacts/verify" && artifactService) {
      requireScope(principal, "rae.work.report");
      const value = z
        .object({
          id: uuid,
          workerId: z.string(),
          nodeId: uuid,
          fence: z.number().int(),
          sha256: z.string().length(64),
          sizeBytes: z.number().int().min(0),
        })
        .parse(input);
      requireWorkerIdentity(principal, value.workerId);
      key(req);
      return send(
        res,
        200,
        await artifactService.verify({ ...value, projects: authorizedProjects(principal) }),
      );
    }
    if (
      req.method === "GET" &&
      /^\/api\/v2\/artifacts\/[0-9a-f-]{36}\/download$/.test(route) &&
      artifactService
    ) {
      requireScope(principal, "rae.run.read");
      const artifact = await store.getArtifact(route.split("/")[4]);
      if (!artifact) return send(res, 404, { error: "artifact not found" });
      const run = await store.getRun(artifact.runId);
      if (!run) return send(res, 404, { error: "run not found" });
      requireProject(principal, run.projectId);
      return send(res, 200, await artifactService.download({ artifact }));
    }
    if (req.method === "POST" && route === "/mcp")
      return handleStreamableMcp({ request: req, response: res, body: input, store, principal });
    return send(res, 404, { error: "not found" });
  } catch (error) {
    const status = errorStatus(error);
    if (status === 409) metrics.leaseFailures += 1;
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    logger("warn", "platform request failed", {
      route,
      status,
      error: errorMessage(error),
      traceparent: span,
    });
    const headers: Record<string, string> = {};
    if (status === 401 || status === 403) {
      const detail = status === 403 ? ', error="insufficient_scope"' : "";
      headers["www-authenticate"] =
        `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp"${detail}`;
    }
    if (status === 413) {
      res.shouldKeepAlive = false;
      headers.connection = "close";
      res.once("finish", () => req.socket.destroySoon());
    }
    return send(
      res,
      status,
      { error: status === 500 ? "internal error" : errorMessage(error) },
      headers,
    );
  } finally {
    metrics.observe(req.method ?? "UNKNOWN", res.statusCode || 500, Date.now() - started);
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    logger("info", "platform request", {
      route,
      status: res.statusCode,
      durationMs: Date.now() - started,
      traceparent: span,
    });
  }
}

/** Creates the Node HTTP server around the testable authenticated request handler. */
export function createPlatformServer(dependencies: PlatformDependencies) {
  const activeEventStreams = new Set<EventStream>();
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void handlePlatformRequest(req, res, { ...dependencies, activeEventStreams }).catch((error) => {
      try {
        dependencies.logger?.("error", "unhandled platform request failure", {
          route: new URL(req.url ?? "/", "http://localhost").pathname,
          error: errorMessage(error),
        });
      } catch {
        /* Request containment cannot depend on the diagnostic sink. */
      }
      if (res.headersSent) {
        closeFailedResponse(res);
        return;
      }
      try {
        send(res, 500, { error: "internal error" });
      } catch {
        closeFailedResponse(res);
      }
    });
  });
  const platformServer = server as PlatformServer;
  platformServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  platformServer.closePlatformStreams = () => {
    for (const stream of [...activeEventStreams]) {
      stream.abort.abort();
      if (!stream.response.writableEnded && !stream.response.destroyed) stream.response.end();
    }
  };
  platformServer.closeGracefully = ({ graceMs = 5000 } = {}) =>
    new Promise<void>((resolve, reject) => {
      dependencies.store.beginShutdown?.();
      platformServer.closePlatformStreams();
      server.closeIdleConnections?.();
      const timer = setTimeout(
        () => {
          for (const socket of sockets) socket.destroy();
        },
        Math.max(0, graceMs),
      );
      timer.unref?.();
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  return platformServer;
}

import type { Socket } from "node:net";
import type { Server } from "node:http";
import { readJsonBody, HttpBodyError } from "./http-body.js";
import {
  pageRunEvents,
  streamEventCursor,
  encodeEventCursor,
  EventPageError,
  type EventPageStore,
} from "./event-pages.js";
import type { MemoryStore, PostgresStore } from "./store.js";
import type { Principal } from "./authorization.js";
import type { PlatformConfig } from "./config.js";
import type { createArtifactService } from "./artifacts.js";
interface EventStream {
  response: ServerResponse;
  abort: AbortController;
}
interface StreamStore extends EventPageStore {
  getRun(id: string): Promise<{ state: string } | null>;
}
export interface PlatformDependencies {
  store: MemoryStore | PostgresStore;
  authenticate: (authorization?: string) => Promise<Principal>;
  artifactService?: ReturnType<typeof createArtifactService> | null;
  logger?: (level: string, message: string, fields?: Record<string, unknown>) => unknown;
  metrics?: Metrics;
  oidc?: PlatformConfig["oidc"] | null;
  resourceBaseUrl?: string | null;
  allowedHosts?: string[];
  activeEventStreams?: Set<EventStream> | null;
  ready?: () => boolean;
}
export interface PlatformServer extends Server {
  closePlatformStreams(): void;
  closeGracefully(options?: { graceMs?: number }): Promise<void>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown platform failure";
}
function errorStatus(error: unknown): number {
  if (error instanceof HttpBodyError || error instanceof EventPageError) return error.status;
  if (error instanceof z.ZodError) return 400;
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  )
    return error.statusCode;
  return 500;
}

import { MAX_RUN_NODES } from "./store.js";
