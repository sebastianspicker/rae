/** Purpose: verify bounded SSE paging, backpressure, terminal draining, and disconnect cleanup. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { createPlatformServer, streamRunEvents } from "../src/http.mjs";
import { digest, MemoryStore } from "../src/store.mjs";

class TestResponse extends EventEmitter {
  constructor({ backpressureAt = new Set(), disconnectAt = null } = {}) {
    super();
    this.backpressureAt = backpressureAt;
    this.disconnectAt = disconnectAt;
    this.chunks = [];
    this.ended = false;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
  }
  write(chunk) {
    this.chunks.push(chunk);
    const count = this.chunks.length;
    if (count === this.disconnectAt) {
      queueMicrotask(() => this.emit("close"));
      return false;
    }
    if (this.backpressureAt.has(count)) {
      queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return true;
  }
  end() {
    this.ended = true;
  }
}

test("terminal SSE uses bounded pages, honors backpressure, and drains the terminal event", async () => {
  const allEvents = Array.from({ length: 205 }, (_, index) => ({
    id: index + 1,
    type: index === 204 ? "run.succeeded" : "node.succeeded",
    payload: {},
  }));
  const calls = [];
  const store = {
    async listRunEventsAfter(_runId, afterId, limit) {
      calls.push({ afterId, limit });
      return allEvents.filter((event) => event.id > afterId).slice(0, limit);
    },
    async getRun() {
      return { state: "succeeded" };
    },
  };
  const response = new TestResponse({ backpressureAt: new Set([1, 100, 205]) });
  await streamRunEvents({}, response, store, "run", 0);
  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  assert.equal(response.chunks.length, 205);
  assert.match(response.chunks.at(-1), /"type":"run\.succeeded"/);
  assert.ok(calls.every((call) => call.limit === 100));
  assert.ok(calls.every((call) => call.afterId >= 0));
  assert.ok(calls.length >= 4);
});

test("SSE stops promptly when the response disconnects under backpressure", async () => {
  const store = {
    async listRunEventsAfter() {
      return [{ id: 1, type: "node.succeeded", payload: {} }];
    },
    async getRun() {
      return { state: "running" };
    },
  };
  const response = new TestResponse({ disconnectAt: 1 });
  await streamRunEvents({}, response, store, "run", 0);
  assert.equal(response.chunks.length, 1);
  assert.equal(response.ended, false);
});

test("the non-stream event route preserves the complete JSON array response", async (t) => {
  const store = new MemoryStore();
  const definition = { nodes: [{ key: "one" }] };
  const run = await store.createRun({
    projectId: "project-a",
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "run",
  });
  await store.signalRun({
    runId: run.id,
    kind: "approval",
    payload: { accepted: true },
    idempotencyKey: "signal",
  });
  const server = createPlatformServer({
    store,
    authenticate: async () => ({
      sub: "reader",
      scopes: new Set(["rae.run.read"]),
      claims: { projects: ["project-a"] },
    }),
    resourceBaseUrl: "http://127.0.0.1",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/runs/${run.id}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(
    (await response.json()).map((event) => event.type),
    ["run.queued", "signal.approval"],
  );
});

test("a post-header SSE store failure is logged and contained", async (t) => {
  const messages = [];
  const server = createPlatformServer({
    store: {
      async getRun() {
        return {
          id: "00000000-0000-4000-8000-000000000000",
          projectId: "project-a",
          state: "running",
        };
      },
      async listRunEventsAfter() {
        throw new Error("database stream failed");
      },
    },
    authenticate: async () => ({
      sub: "reader",
      scopes: new Set(["rae.run.read"]),
      claims: { projects: ["project-a"] },
    }),
    logger(level, message) {
      messages.push({ level, message });
    },
    resourceBaseUrl: "http://127.0.0.1",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    if (server.listening) server.close();
  });
  const address = server.address();
  await assert.rejects(
    fetch(
      `http://127.0.0.1:${address.port}/api/v2/runs/00000000-0000-4000-8000-000000000000/events?stream=true`,
    ).then((response) => response.text()),
  );
  assert.ok(messages.some((entry) => entry.message === "platform event stream failed"));
  await server.closeGracefully({ graceMs: 100 });
});

test("graceful server shutdown closes an active event stream promptly", async () => {
  const store = new MemoryStore();
  const definition = { nodes: [{ key: "one" }] };
  const run = await store.createRun({
    projectId: "project-a",
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "shutdown-run",
  });
  const server = createPlatformServer({
    store,
    authenticate: async () => ({
      sub: "reader",
      scopes: new Set(["rae.run.read"]),
      claims: { projects: ["project-a"] },
    }),
    resourceBaseUrl: "http://127.0.0.1",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v2/runs/${run.id}/events?stream=true`,
  );
  assert.equal(response.status, 200);
  const started = Date.now();
  await server.closeGracefully({ graceMs: 100 });
  assert.ok(Date.now() - started < 500);
  await response.body.cancel();
});

test("graceful server shutdown cancels an active worker long poll", async () => {
  const store = new MemoryStore();
  await store.registerWorker({
    workerId: "worker-a",
    repositoryDigest: "a".repeat(64),
    worktreeDigest: "b".repeat(64),
    projects: ["project-a"],
    idempotencyKey: "register",
  });
  const server = createPlatformServer({
    store,
    authenticate: async () => ({
      sub: "worker-a",
      scopes: new Set(["rae.work.claim"]),
      claims: { projects: ["project-a"] },
    }),
    resourceBaseUrl: "http://127.0.0.1",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const request = fetch(`http://127.0.0.1:${address.port}/api/v2/workers/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "long-poll" },
    body: JSON.stringify({ workerId: "worker-a", longPollSeconds: 25 }),
  });
  await waitUntil(() => store.workWaiters.size === 1);
  const started = Date.now();
  await server.closeGracefully({ graceMs: 100 });
  const response = await request;
  assert.equal(response.status, 503);
  assert.equal(store.workWaiters.size, 0);
  assert.equal(store.closed, true);
  assert.ok(Date.now() - started < 500);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for HTTP test precondition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
