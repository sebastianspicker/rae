/** Purpose: deterministic reference tests for hosted run completion and claim lifecycle. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  digest,
  MemoryStore,
  NODE_STATE,
  RUN_STATE,
  TERMINAL_NODE_STATES,
  TERMINAL_RUN_STATES,
  PostgresStore,
} from "../src/store.mjs";

const PROJECT = "project-a";
const WORKER = "worker-a";

async function configuredStore({ nodes, now } = {}) {
  const store = new MemoryStore(now ? { now } : undefined);
  await store.registerWorker({
    workerId: WORKER,
    repositoryDigest: "a".repeat(64),
    worktreeDigest: "b".repeat(64),
    projects: [PROJECT],
    idempotencyKey: "register",
  });
  const definition = { nodes: nodes || [{ key: "one" }] };
  const run = await store.createRun({
    projectId: PROJECT,
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "run",
  });
  return { store, run };
}

async function claim(store, key) {
  return store.claim({
    workerId: WORKER,
    projects: [PROJECT],
    idempotencyKey: key,
  });
}

test("exported state enums define the MemoryStore reference lifecycle", () => {
  assert.deepEqual(TERMINAL_RUN_STATES, ["succeeded", "failed", "cancelled"]);
  assert.deepEqual(TERMINAL_NODE_STATES, ["succeeded", "failed", "cancelled"]);
  assert.equal(RUN_STATE.RUNNING, "running");
  assert.equal(NODE_STATE.LEASED, "leased");
});

test("concurrent final node reports produce one successful run completion", async () => {
  const { store, run } = await configuredStore({
    nodes: [
      { key: "one", access: "read" },
      { key: "two", access: "read" },
    ],
  });
  const [first, second] = await Promise.all([claim(store, "claim-1"), claim(store, "claim-2")]);
  await Promise.all([
    store.report({
      workerId: WORKER,
      nodeId: first.nodeId,
      fence: first.fence,
      outcome: "succeeded",
      idempotencyKey: "report-1",
    }),
    store.report({
      workerId: WORKER,
      nodeId: second.nodeId,
      fence: second.fence,
      outcome: "succeeded",
      idempotencyKey: "report-2",
    }),
  ]);
  assert.equal((await store.getRun(run.id)).state, RUN_STATE.SUCCEEDED);
  const events = await store.listRunEvents(run.id);
  assert.equal(events.filter((event) => event.type === "run.succeeded").length, 1);
  assert.equal(store.outbox.filter((entry) => entry.topic === "run.succeeded").length, 1);
  const terminal = events.at(-1);
  assert.equal(terminal.createdAt, terminal.payload.completedAt);
});

test("a mixed terminal node set makes the run failed only after every node finishes", async () => {
  const { store, run } = await configuredStore({
    nodes: [{ key: "one" }, { key: "two" }],
  });
  const first = await claim(store, "claim-1");
  const second = await claim(store, "claim-2");
  const firstResult = await store.report({
    workerId: WORKER,
    nodeId: first.nodeId,
    fence: first.fence,
    outcome: "failed",
    idempotencyKey: "report-1",
  });
  assert.equal(firstResult.runState, RUN_STATE.RUNNING);
  assert.equal((await store.getRun(run.id)).state, RUN_STATE.RUNNING);
  const finalResult = await store.report({
    workerId: WORKER,
    nodeId: second.nodeId,
    fence: second.fence,
    outcome: "succeeded",
    idempotencyKey: "report-2",
  });
  assert.equal(finalResult.runState, RUN_STATE.FAILED);
  assert.equal((await store.getRun(run.id)).state, RUN_STATE.FAILED);
});

test("cancel and completion serialize without overwriting a terminal run", async () => {
  const { store, run } = await configuredStore();
  const leased = await claim(store, "claim");
  const results = await Promise.allSettled([
    store.report({
      workerId: WORKER,
      nodeId: leased.nodeId,
      fence: leased.fence,
      outcome: "succeeded",
      idempotencyKey: "report",
    }),
    store.cancelRun({ runId: run.id, idempotencyKey: "cancel" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const final = await store.getRun(run.id);
  assert.ok(TERMINAL_RUN_STATES.includes(final.state));
  const terminalEvents = (await store.listRunEvents(run.id)).filter((event) =>
    ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type),
  );
  assert.equal(terminalEvents.length, 1);
});

test("duplicate reports share one fenced mutation, event, and outbox record", async () => {
  const { store, run } = await configuredStore();
  const leased = await claim(store, "claim");
  const report = {
    workerId: WORKER,
    nodeId: leased.nodeId,
    fence: leased.fence,
    outcome: "succeeded",
    result: { digest: "result" },
    idempotencyKey: "same-report",
  };
  const [first, second] = await Promise.all([store.report(report), store.report(report)]);
  assert.deepEqual(first, second);
  const events = await store.listRunEvents(run.id);
  assert.equal(events.filter((event) => event.type === "node.succeeded").length, 1);
  assert.equal(events.filter((event) => event.type === "run.succeeded").length, 1);
  assert.equal(store.outbox.filter((entry) => entry.topic === "node.succeeded").length, 1);
  assert.equal(store.outbox.filter((entry) => entry.topic === "run.succeeded").length, 1);
});

test("an expired lease is reclaimed with a higher fence and rejects the stale report", async () => {
  let clock = Date.parse("2026-09-06T12:00:00.000Z");
  const { store } = await configuredStore({ now: () => clock });
  const stale = await claim(store, "claim-1");
  clock += 60_001;
  const current = await claim(store, "claim-2");
  assert.equal(current.nodeId, stale.nodeId);
  assert.equal(current.fence, stale.fence + 1);
  await assert.rejects(
    store.report({
      workerId: WORKER,
      nodeId: stale.nodeId,
      fence: stale.fence,
      outcome: "succeeded",
      idempotencyKey: "stale-report",
    }),
    /expired|fenced/,
  );
});

test("long poll registers before probing, wakes on creation, and persists no empty result early", async () => {
  const store = new MemoryStore();
  await store.registerWorker({
    workerId: WORKER,
    repositoryDigest: "a".repeat(64),
    worktreeDigest: "b".repeat(64),
    projects: [PROJECT],
    idempotencyKey: "register",
  });
  const pending = store.claim({
    workerId: WORKER,
    projects: [PROJECT],
    longPollSeconds: 1,
    idempotencyKey: "waiting-claim",
  });
  await Promise.resolve();
  assert.equal(store.workWaiters.size, 1);
  assert.equal(store.keys.has(`claim:${WORKER}:waiting-claim`), false);
  const definition = { nodes: [{ key: "late" }] };
  await store.createRun({
    projectId: PROJECT,
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "late-run",
  });
  const result = await pending;
  assert.equal(result.nodeKey, "late");
  assert.equal(store.workWaiters.size, 0);
});

test("long poll records an empty idempotent result only at timeout", async () => {
  const store = new MemoryStore();
  await store.registerWorker({
    workerId: WORKER,
    repositoryDigest: "a".repeat(64),
    worktreeDigest: "b".repeat(64),
    projects: [PROJECT],
    idempotencyKey: "register",
  });
  const pending = store.claim({
    workerId: WORKER,
    projects: [PROJECT],
    longPollSeconds: 0.02,
    idempotencyKey: "timeout-claim",
  });
  await Promise.resolve();
  assert.equal(store.keys.has(`claim:${WORKER}:timeout-claim`), false);
  assert.equal(await pending, null);
  assert.equal(store.keys.has(`claim:${WORKER}:timeout-claim`), true);
  assert.equal(store.workWaiters.size, 0);
});

test("paged event reads advance strictly after the cursor", async () => {
  const { store, run } = await configuredStore();
  await store.signalRun({ runId: run.id, kind: "one", payload: {}, idempotencyKey: "signal-1" });
  await store.signalRun({ runId: run.id, kind: "two", payload: {}, idempotencyKey: "signal-2" });
  const page = await store.listRunEventsAfter(run.id, 1, 1);
  assert.deepEqual(
    page.map((event) => event.id),
    [2],
  );
});

test("Postgres long poll replaces a failed listener before waiting again", async () => {
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.releases = [];
    }
    async query() {
      return { rows: [], rowCount: 0 };
    }
    release(error) {
      this.releases.push(error || null);
    }
  }
  const clients = [];
  const pool = {
    async connect() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    async end() {},
  };
  const store = new PostgresStore(pool);
  let available = false;
  store.claimOnce = async () =>
    available
      ? { found: true, response: { nodeId: "late-node" } }
      : { found: false, response: null };
  const pending = store.claim({
    workerId: WORKER,
    projects: [PROJECT],
    longPollSeconds: 1,
    idempotencyKey: "listener-reconnect",
  });
  await waitUntil(() => clients.length === 1 && store.workWaiters.size === 1);
  const listenerFailure = new Error("listener disconnected");
  clients[0].emit("error", listenerFailure);
  await waitUntil(() => clients.length === 2 && store.workWaiters.size === 1);
  assert.equal(clients[0].releases[0], listenerFailure);
  available = true;
  clients[1].emit("notification", { channel: "rae_platform_work", payload: "work" });
  assert.deepEqual(await pending, { nodeId: "late-node" });
  assert.equal(store.workWaiters.size, 0);
  await store.close();
  assert.equal(clients[1].releases.length, 1);
});

test("Postgres shutdown cancels a long poll without probing the ended pool", async () => {
  class FakeClient extends EventEmitter {
    async query() {
      return { rows: [], rowCount: 0 };
    }
    release() {
      this.released = true;
    }
  }
  const client = new FakeClient();
  let ended = false;
  const store = new PostgresStore({
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    },
  });
  let probes = 0;
  store.claimOnce = async () => {
    probes += 1;
    return { found: false, response: null };
  };
  const pending = store.claim({
    workerId: WORKER,
    projects: [PROJECT],
    longPollSeconds: 25,
    idempotencyKey: "shutdown-claim",
  });
  await waitUntil(() => store.workWaiters.size === 1);
  const rejected = assert.rejects(pending, /shutting down/);
  await store.close();
  await rejected;
  assert.equal(probes, 1);
  assert.equal(store.workWaiters.size, 0);
  assert.equal(client.released, true);
  assert.equal(ended, true);
});

test("Postgres close waits for an in-flight LISTEN and releases its late client", async () => {
  let resolveListen;
  let listenStarted = false;
  let releases = 0;
  let ended = false;
  class DelayedClient extends EventEmitter {
    async query(sql) {
      if (sql === "LISTEN rae_platform_work") {
        listenStarted = true;
        await new Promise((resolve) => {
          resolveListen = resolve;
        });
      }
      return { rows: [], rowCount: 0 };
    }
    release() {
      releases += 1;
    }
  }
  const client = new DelayedClient();
  const store = new PostgresStore({
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    },
  });
  const starting = store.ensureNotificationListener();
  const rejected = assert.rejects(starting, /shutting down/);
  await waitUntil(() => listenStarted);
  const closing = store.close();
  assert.equal(store.closed, true);
  assert.equal(ended, false);
  resolveListen();
  await rejected;
  await closing;
  assert.equal(store.notificationClient, null);
  assert.equal(releases, 1);
  assert.equal(ended, true);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test precondition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
