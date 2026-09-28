/** Management requests stay on loopback and never trigger database refreshes. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createManagementServer } from "../src/management.js";
import { Metrics } from "../src/observability.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(port: number, path: string, host = `127.0.0.1:${port}`, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("cached management routes reject rebinding hosts and keep scrapes independent of the database", async (t) => {
  let reads = 0;
  const source = {
    async isReady() {
      reads++;
      return true;
    },
    async lifecycleSnapshot() {
      reads++;
      return { queueDepth: 7 };
    },
  };
  const metrics = new Metrics();
  assert.throws(() => createManagementServer({ source, metrics, host: "0.0.0.0" }), /loopback/);
  const management = createManagementServer({ source, metrics, intervalMs: 60_000 });
  t.after(() => management.close());
  management.server.listen(0, management.host);
  await once(management.server, "listening");
  const address = management.server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  assert.equal((await request(port, "/ready")).status, 200);
  const before = reads;
  const responses = await Promise.all(Array.from({ length: 30 }, () => request(port, "/metrics")));
  assert.ok(
    responses.every(
      (response) => response.status === 200 && response.body.includes("rae_platform_queue_depth 7"),
    ),
  );
  assert.equal(reads, before);
  assert.equal((await request(port, "/metrics", "attacker.example")).status, 403);
  assert.equal((await request(port, "/metrics", `user@127.0.0.1:${port}`)).status, 403);
  assert.equal((await request(port, "/metrics", undefined, "POST")).status, 405);
  assert.equal((await request(port, "/unknown")).status, 404);
});
test("stalled refreshes fail readiness and never overlap further queries", async (t) => {
  let calls = 0;
  let aborted = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const metrics = new Metrics();
  const management = createManagementServer({
    metrics,
    intervalMs: 20,
    timeoutMs: 10,
    source: {
      async isReady(signal) {
        calls++;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await pending;
        return true;
      },
      async lifecycleSnapshot() {
        calls++;
        throw new Error("database failure");
      },
    },
  });
  t.after(() => management.close());
  await sleep(65);
  assert.equal(calls, 2);
  assert.ok(aborted);
  assert.equal(metrics.ready, 0);
  release();
  await management.close();
});
test("metric labels and untrusted attempt counters have bounded valid output", () => {
  const metrics = new Metrics();
  for (let i = 0; i < 10_000; i++) metrics.observe(`CUSTOM${i}`, 200, NaN);
  assert.equal(metrics.requests.size, 1);
  metrics.observeAttempt({
    resource_usage: { input_tokens: -1, output_tokens: "NaN" },
    context_manifest: { included_bytes: Infinity },
  });
  assert.equal(metrics.modelInputTokens, 0);
  assert.equal(metrics.modelOutputTokens, 0);
  assert.equal(metrics.contextIncludedBytes, 0);
  assert.ok(!metrics.render().includes("NaN"));
});

test("repeated finite large attempt counters cannot overflow Prometheus output", () => {
  const metrics = new Metrics();
  for (let i = 0; i < 2; i++)
    metrics.observeAttempt({
      resource_usage: { input_tokens: 1e308, output_tokens: 1e308 },
      context_manifest: { included_bytes: 1e308 },
    });
  assert.equal(metrics.modelInputTokens, Number.MAX_SAFE_INTEGER);
  assert.ok(!metrics.render().includes("Infinity"));
});
