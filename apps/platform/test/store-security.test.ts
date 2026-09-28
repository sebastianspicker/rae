/** Integrated memory-store claims preserve fences and event reads seek bounded keysets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, MemoryStore } from "../src/store.js";
import { encodeEventCursor } from "../src/event-pages.js";
import type { MemoryEvent } from "../src/store-types.js";
async function fixture() {
  let now = Date.now();
  const store = new MemoryStore({ now: () => now });
  await store.registerWorker({
    workerId: "worker",
    projects: ["allowed"],
    repositoryDigest: "a",
    worktreeDigest: "b",
    idempotencyKey: "register",
  });
  const definition = { nodes: [{ key: "node" }] };
  const run = await store.createRun({
    projectId: "allowed",
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "run",
  });
  const leased = await store.claim({
    workerId: "worker",
    projects: ["*"],
    idempotencyKey: "claim",
  });
  assert.ok(leased);
  const owner = { workerId: "worker", nodeId: leased.nodeId, fence: leased.fence };
  await store.reserveArtifact({
    ...owner,
    artifactId: "artifact",
    objectKey: "reservations/artifact",
    expectedSha256: "a".repeat(64),
    expectedSizeBytes: 1,
  });
  const request = {
    ...owner,
    id: "artifact",
    sha256: "a".repeat(64),
    sizeBytes: 1,
    claimId: "claim-a",
    claimSeconds: 5,
  };
  return {
    store,
    run,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("verification claims are exclusive, reclaimable after expiry, and token-exact", async () => {
  const { store, request, advance } = await fixture();
  const attempts = await Promise.allSettled([
    store.claimArtifactVerification(request),
    store.claimArtifactVerification({ ...request, claimId: "claim-b" }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  advance(5001);
  const next = await store.claimArtifactVerification({ ...request, claimId: "claim-next" });
  await store.releaseArtifactVerification(request);
  await assert.rejects(store.verifyArtifact({ ...request, objectVersionId: "v" }), /claim/);
  assert.equal(
    (await store.verifyArtifact({ ...request, claimId: next.claimId, objectVersionId: "v" })).state,
    "verified",
  );
});
test("cancelled runs, expired fences, and reservation mismatches cannot finalize", async () => {
  for (const mutation of ["cancel", "expire", "digest", "size", "node"] as const) {
    const { store, run, request, advance } = await fixture();
    await store.claimArtifactVerification(request);
    if (mutation === "cancel") await store.cancelRun({ runId: run.id, idempotencyKey: "cancel" });
    if (mutation === "expire") advance(60_001);
    const changed = { ...request, objectVersionId: "v" };
    if (mutation === "digest") changed.sha256 = "b".repeat(64);
    if (mutation === "size") changed.sizeBytes = 2;
    if (mutation === "node") changed.nodeId = "foreign";
    await assert.rejects(store.verifyArtifact(changed), /fenced attempt or claim/);
    assert.equal((await store.getArtifact(request.id))?.state, "reserved");
  }
});
test("wildcard token scopes never expand registered worker project membership", async () => {
  const store = new MemoryStore();
  await store.registerWorker({
    workerId: "worker",
    projects: ["allowed"],
    repositoryDigest: "a",
    worktreeDigest: "b",
    idempotencyKey: "register",
  });
  const definition = { nodes: [{ key: "node" }] };
  await store.createRun({
    projectId: "denied",
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "run",
  });
  assert.equal(
    await store.claim({ workerId: "worker", projects: ["*"], idempotencyKey: "claim" }),
    null,
  );
});
test("event keyset reads touch only the index search and selected rows", async () => {
  const store = new MemoryStore();
  let reads = 0;
  const events: MemoryEvent[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: index + 1,
    type: "test",
    payload: {},
    traceparent: null,
    createdAt: "2026-09-07T00:00:00Z",
  }));
  store.events.set(
    "run",
    new Proxy(events, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    }),
  );
  const page = await store.listRunEvents("run", {
    cursor: encodeEventCursor("run", 9900),
    limit: 10,
  });
  assert.deepEqual(
    page.events.map((event) => event.id),
    [9901, 9902, 9903, 9904, 9905, 9906, 9907, 9908, 9909, 9910],
  );
  assert.ok(reads < 50, `bounded seek read ${reads} rows`);
  await assert.rejects(store.listRunEventsAfter("run", "invalid"), /cursor/);
  assert.deepEqual(await store.listRunEventsAfter("run", "9007199254740993"), []);
});

test("claim replay checks current token and current registered membership", async () => {
  const { store, request } = await fixture();
  await assert.rejects(store.claim({ workerId: "worker", projects: [], idempotencyKey: "claim" }), {
    statusCode: 403,
  });
  const replay = await store.claim({
    workerId: "worker",
    projects: ["allowed", "extra"],
    idempotencyKey: "claim",
  });
  assert.equal(replay?.nodeId, request.nodeId);
  const worker = store.workers.get("worker");
  assert.ok(worker);
  worker.projects = [];
  await assert.rejects(
    store.claim({ workerId: "worker", projects: ["*"], idempotencyKey: "claim" }),
    { statusCode: 403 },
  );
});
test("idempotency namespaces separate colon-containing project and worker identifiers", async () => {
  const store = new MemoryStore();
  const definition = { nodes: [{ key: "node" }] };
  const common = {
    revision: { definition, digest: digest(definition) },
    nodes: definition.nodes,
    request: {},
  };
  const first = await store.createRun({
    ...common,
    projectId: "victim:segment",
    idempotencyKey: "same",
  });
  const second = await store.createRun({
    ...common,
    projectId: "victim",
    idempotencyKey: "segment:same",
  });
  assert.notEqual(first.id, second.id);
  assert.equal((await store.getRun(second.id))?.projectId, "victim");
  await store.registerWorker({
    workerId: "worker:segment",
    projects: ["first"],
    repositoryDigest: "a",
    worktreeDigest: "b",
    idempotencyKey: "same",
  });
  const worker = await store.registerWorker({
    workerId: "worker",
    projects: ["second"],
    repositoryDigest: "a",
    worktreeDigest: "b",
    idempotencyKey: "segment:same",
  });
  assert.equal(worker.workerId, "worker");
  assert.deepEqual(worker.projects, ["second"]);
});
test("node limits reject oversized batches before any mutation", async () => {
  const store = new MemoryStore();
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ key: `node-${i}` }));
  const definition = { nodes };
  const common = {
    projectId: "project",
    revision: { definition, digest: digest(definition) },
    request: {},
  };
  await store.createRun({ ...common, nodes, idempotencyKey: "max" });
  assert.equal(store.nodes.size, 1000);
  await assert.rejects(
    store.createRun({ ...common, nodes: [...nodes, { key: "extra" }], idempotencyKey: "overflow" }),
    /node count/,
  );
  assert.equal(store.runs.size, 1);
  assert.equal(store.nodes.size, 1000);
});
