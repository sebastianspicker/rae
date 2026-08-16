/** Purpose: raw Node HTTP implementation of the experimental /api/v2 surface. */
import { createServer } from "node:http";
import { z } from "zod";
import {
  authorizedProjects,
  PLATFORM_SCOPES,
  requireProject,
  requireScope,
  requireWorkerIdentity,
} from "./auth.mjs";
import { handleStreamableMcp } from "./mcp.mjs";
import { Metrics, traceparent } from "./observability.mjs";

const uuid = z.string().uuid();
const object = z.record(z.string(), z.unknown());
const runInput = z.object({
  projectId: z.string(),
  revision: z.object({ digest: z.string().length(64), definition: object }),
  nodes: z.array(
    z.object({
      key: z.string(),
      payload: object.optional(),
      access: z.enum(["read", "write"]).default("read"),
    }),
  ),
  request: object.default({}),
  repositoryDigest: z.string().length(64).optional(),
  worktreeDigest: z.string().length(64).optional(),
});

async function body(req) {
  let text = "";
  for await (const part of req) {
    text += part;
    if (Buffer.byteLength(text) > 1_050_000)
      throw Object.assign(new Error("request too large"), { statusCode: 413 });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(value));
}

function key(req) {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value))
    throw Object.assign(new Error("Idempotency-Key is required"), { statusCode: 400 });
  return value;
}

async function streamRunEvents(req, res, store, runId, fromId = 0) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let cursor = Number.isSafeInteger(fromId) && fromId >= 0 ? fromId : 0;
  let closed = false;
  req.once("close", () => {
    closed = true;
  });
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!closed && Date.now() < deadline) {
    const events = await store.listRunEvents(runId);
    for (const event of events) {
      const eventId = Number(event.id);
      if (!Number.isSafeInteger(eventId) || eventId <= cursor) continue;
      res.write(`id: ${eventId}\nevent: rae-event\ndata: ${JSON.stringify(event)}\n\n`);
      cursor = eventId;
    }
    const run = await store.getRun(runId);
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!closed) res.end();
}

/** Handles one authenticated platform request with its explicit dependency boundary. */
export async function handlePlatformRequest(
  req,
  res,
  {
    store,
    authenticate,
    artifactService = null,
    logger = () => {},
    metrics = new Metrics(),
    oidc = null,
    resourceBaseUrl = null,
    allowedHosts = [],
  },
) {
  const started = Date.now();
  const span = traceparent(req.headers.traceparent);
  res.setHeader("traceparent", span);
  try {
    const route = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && route === "/healthz")
      return send(res, 200, { status: "ok", experimental: true });
    if (req.method === "GET" && route === "/readyz") {
      if (!(await store.isReady())) return send(res, 503, { status: "stale-schema" });
      metrics.ready = 1;
      return send(res, 200, { status: "ready" });
    }
    if (req.method === "GET" && route === "/metrics") {
      if (store.metricsSnapshot) metrics.applySnapshot(await store.metricsSnapshot());
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return res.end(metrics.render());
    }
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
    const input = ["POST", "PUT", "PATCH"].includes(req.method) ? await body(req) : {};

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
        const eventUrl = new URL(req.url, "http://localhost");
        if (eventUrl.searchParams.get("stream") === "true")
          return streamRunEvents(
            req,
            res,
            store,
            run.id,
            Number(eventUrl.searchParams.get("from") || 0),
          );
        return send(res, 200, await store.listRunEvents(run.id));
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
          ? await store.heartbeat({ ...value, idempotencyKey })
          : await store.report({
              ...value,
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
      return send(res, 201, await artifactService.reserve(value));
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
      return send(res, 200, await artifactService.verify(value));
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
      requireProject(principal, run.projectId);
      return send(res, 200, await artifactService.download({ artifact }));
    }
    if (req.method === "POST" && route === "/mcp")
      return handleStreamableMcp({ request: req, response: res, body: input, store, principal });
    return send(res, 404, { error: "not found" });
  } catch (error) {
    const status = error.statusCode || (error instanceof z.ZodError ? 400 : 500);
    if (status === 409) metrics.leaseFailures += 1;
    const route = new URL(req.url, "http://localhost").pathname;
    logger("warn", "platform request failed", {
      route,
      status,
      error: error.message,
      traceparent: span,
    });
    const headers = {};
    if (status === 401 || status === 403) {
      const detail = status === 403 ? ', error="insufficient_scope"' : "";
      headers["www-authenticate"] =
        `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp"${detail}`;
    }
    return send(res, status, { error: status === 500 ? "internal error" : error.message }, headers);
  } finally {
    metrics.observe(req.method, res.statusCode || 500, Date.now() - started);
    const route = new URL(req.url, "http://localhost").pathname;
    logger("info", "platform request", {
      route,
      status: res.statusCode,
      durationMs: Date.now() - started,
      traceparent: span,
    });
  }
}

/** Creates the Node HTTP server around the testable authenticated request handler. */
export function createPlatformServer(dependencies) {
  return createServer((req, res) => handlePlatformRequest(req, res, dependencies));
}
