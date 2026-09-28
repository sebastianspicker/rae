/** Live HTTP and MCP tests verify bounded responses and authorization at the integrated boundary. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createPlatformServer } from "../src/http.js";
import { digest, MemoryStore } from "../src/store.js";
import { PLATFORM_SCOPES } from "../src/authorization.js";
import { MAX_EVENT_PAGE_BYTES } from "../src/event-pages.js";
import { createArtifactService, type ArtifactStorage } from "../src/artifacts.js";
import { Readable } from "node:stream";
async function fixture(t: TestContext) {
  const store = new MemoryStore();
  const definition = { nodes: [{ key: "node" }] };
  const run = await store.createRun({
    projectId: "project",
    revision: { digest: digest(definition), definition },
    nodes: definition.nodes,
    request: {},
    idempotencyKey: "run",
  });
  let project = "project";
  const storageCalls: string[] = [];
  const objects: ArtifactStorage = {
    async uploadUrl() {
      storageCalls.push("upload");
      return "https://storage.invalid/upload";
    },
    async read() {
      storageCalls.push("read");
      return { body: Readable.from([]), versionId: "v" };
    },
    async quarantine() {
      storageCalls.push("quarantine");
    },
    async downloadUrl() {
      storageCalls.push("download");
      return "https://storage.invalid/download";
    },
  };
  const server = createPlatformServer({
    store,
    artifactService: createArtifactService({
      store,
      objects,
      storage: { bucket: "fixture", region: "fixture" },
    }),
    authenticate: async () => ({
      sub: "worker",
      scopes: new Set(PLATFORM_SCOPES),
      claims: { projects: [project] },
    }),
    ready: () => true,
    allowedHosts: ["127.0.0.1"],
  });
  t.after(() => server.closeGracefully({ graceMs: 100 }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    store,
    run,
    storageCalls,
    port: address.port,
    deny: () => {
      project = "other";
    },
  };
}
async function request(
  port: number,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; bytes: Buffer; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              bytes: Buffer.concat(chunks),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
function object(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString());
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
test("REST pages expose cursors and reject invalid or foreign cursors with project checks", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++) f.store.appendEvent(f.run.id, "test", { i });
  const first = await request(f.port, `/api/v2/runs/${f.run.id}/events`);
  assert.equal(first.status, 200);
  const page = object(first.bytes);
  assert.ok(Array.isArray(page.events));
  assert.equal(page.events.length, 100);
  assert.equal(typeof page.nextCursor, "string");
  assert.equal(
    (await request(f.port, `/api/v2/runs/${f.run.id}/events?cursor=invalid`)).status,
    400,
  );
  assert.equal(
    (await request(f.port, `/api/v2/runs/${f.run.id}/events?stream=true&from=NaN`)).status,
    400,
  );
  const next = await request(
    f.port,
    `/api/v2/runs/${f.run.id}/events?cursor=${page.nextCursor}&limit=1000`,
  );
  assert.equal(next.status, 200);
  const rest = object(next.bytes);
  assert.ok(Array.isArray(rest.events));
  assert.equal(rest.events.length, 106);
  assert.equal(rest.nextCursor, null);
  f.deny();
  assert.equal((await request(f.port, `/api/v2/runs/${f.run.id}/events`)).status, 403);
});
test("application metrics are unavailable and oversized input returns 413 with connection close", async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.port, "/metrics")).status, 404);
  assert.equal((await request(f.port, "/readyz")).status, 200);
  const result = await request(f.port, "/api/v2/runs", "x".repeat(1_060_000), {
    "transfer-encoding": "chunked",
  });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, "close");
  const declared = await request(f.port, "/api/v2/runs", "", { "content-length": "2000000" });
  assert.equal(declared.status, 413);
  assert.equal(declared.headers.connection, "close");
});
test("MCP event responses include JSON-RPC envelope bytes and expose a cursor", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) f.store.appendEvent(f.run.id, "test", '"'.repeat(100_000));
  const result = await request(
    f.port,
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: "x".repeat(500_000),
      method: "tools/call",
      params: { name: "rae_list_events", arguments: { run_id: f.run.id } },
    }),
  );
  assert.equal(result.status, 200);
  assert.ok(result.bytes.length <= MAX_EVENT_PAGE_BYTES);
  const rpc = object(result.bytes);
  assert.ok(rpc.result && typeof rpc.result === "object" && "content" in rpc.result);
  const content = rpc.result.content;
  assert.ok(Array.isArray(content));
  const page = object(Buffer.from(content[0].text));
  assert.ok(Array.isArray(page.events));
  assert.ok(page.events.length > 0 && page.events.length < 9);
  assert.equal(typeof page.nextCursor, "string");
  const resource = await request(
    f.port,
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: `rae://runs/${f.run.id}/events?cursor=${page.nextCursor}&limit=1` },
    }),
  );
  assert.equal(resource.status, 200);
  assert.ok(resource.bytes.length <= MAX_EVENT_PAGE_BYTES);
  const resourceRpc = object(resource.bytes);
  assert.ok(
    resourceRpc.result &&
      typeof resourceRpc.result === "object" &&
      "contents" in resourceRpc.result,
  );
  const contents = resourceRpc.result.contents;
  assert.ok(Array.isArray(contents));
  const resourcePage = object(Buffer.from(contents[0].text));
  assert.ok(Array.isArray(resourcePage.events));
  assert.equal(resourcePage.events.length, 1);
});

test("current-token project revocation blocks cached claims and every lease continuation before storage access", async (t) => {
  const f = await fixture(t);
  const call = (path: string, value: unknown, key = path) =>
    request(f.port, path, JSON.stringify(value), { "idempotency-key": key });
  assert.equal(
    (
      await call("/api/v2/workers/register", {
        workerId: "worker",
        repositoryDigest: "a".repeat(64),
        worktreeDigest: "b".repeat(64),
      })
    ).status,
    201,
  );
  const claimed = object(
    (await call("/api/v2/workers/claim", { workerId: "worker" }, "claim")).bytes,
  );
  assert.ok(
    claimed.claim &&
      typeof claimed.claim === "object" &&
      "nodeId" in claimed.claim &&
      "fence" in claimed.claim,
  );
  const owner = { workerId: "worker", nodeId: claimed.claim.nodeId, fence: claimed.claim.fence };
  const reservation = await call("/api/v2/artifacts/reserve", {
    ...owner,
    sha256: "a".repeat(64),
    sizeBytes: 0,
  });
  assert.equal(reservation.status, 201);
  const artifact = object(reservation.bytes);
  const beforeCalls = f.storageCalls.length;
  const beforeLease = f.store.leases.get(String(owner.nodeId))?.expiresAt;
  const beforeEvents = f.store.events.get(f.run.id)?.length;
  f.deny();
  assert.equal((await call("/api/v2/workers/claim", { workerId: "worker" }, "claim")).status, 403);
  for (const [path, input] of [
    ["/api/v2/workers/heartbeat", owner],
    ["/api/v2/workers/report", owner],
    ["/api/v2/artifacts/reserve", { ...owner, sha256: "a".repeat(64), sizeBytes: 0 }],
    [
      "/api/v2/artifacts/verify",
      { ...owner, id: artifact.id, sha256: "a".repeat(64), sizeBytes: 0 },
    ],
  ] as const)
    assert.ok([403, 409].includes((await call(path, input)).status), path);
  assert.equal(f.storageCalls.length, beforeCalls);
  assert.equal(f.store.leases.get(String(owner.nodeId))?.expiresAt, beforeLease);
  assert.equal(f.store.events.get(f.run.id)?.length, beforeEvents);
});

test("REST and MCP reject oversized node batches before mutation and accept the exact cap", async (t) => {
  const f = await fixture(t);
  const definition = { nodes: [] };
  const envelope = {
    revision: { definition, digest: digest(definition) },
    nodes: Array.from({ length: 1001 }, (_, index) => ({ key: `node-${index}` })),
    request: {},
  };
  const oversized = await request(
    f.port,
    "/api/v2/runs",
    JSON.stringify({ projectId: "project", ...envelope }),
    { "idempotency-key": "rest-overflow" },
  );
  assert.equal(oversized.status, 400);
  assert.equal(f.store.runs.size, 1);
  const mcp = await request(
    f.port,
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rae_submit_run",
        arguments: { project_id: "project", envelope, idempotency_key: "mcp-overflow" },
      },
    }),
  );
  assert.equal(mcp.status, 200);
  const response = object(mcp.bytes);
  assert.ok(
    response.result &&
      typeof response.result === "object" &&
      "isError" in response.result &&
      response.result.isError === true,
  );
  assert.equal(f.store.runs.size, 1);
  envelope.nodes.pop();
  const accepted = await request(
    f.port,
    "/api/v2/runs",
    JSON.stringify({ projectId: "project", ...envelope }),
    { "idempotency-key": "rest-cap" },
  );
  assert.equal(accepted.status, 201, accepted.bytes.toString());
  assert.equal(f.store.runs.size, 2);
});
