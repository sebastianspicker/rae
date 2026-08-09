/** Verifies the remote console proxy keeps upstream credentials and routes bounded. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createRemoteOperatorProxy,
  isAllowedRemoteRequest,
  MAX_REMOTE_RESPONSE_BYTES,
  parseRemoteUrl,
  readRemoteTokenFile,
} from "../lib/remote.mjs";

class MockRequest extends Readable {
  constructor({ method = "GET", headers = {}, body = "" } = {}) {
    super();
    this.method = method;
    this.headers = headers;
    this.body = Buffer.from(body);
  }

  _read() {
    this.push(this.body);
    this.push(null);
  }
}

function tokenFixture(contents = "upstream-token") {
  const directory = mkdtempSync(join(tmpdir(), "rae-operator-remote-"));
  const path = join(directory, "token");
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { directory, path };
}

test("remote URL accepts HTTPS and loopback development only", () => {
  assert.equal(parseRemoteUrl("https://operator.example").origin, "https://operator.example");
  assert.equal(parseRemoteUrl("http://127.0.0.1:8787").origin, "http://127.0.0.1:8787");
  assert.throws(() => parseRemoteUrl("http://operator.example"), /must use HTTPS/);
  assert.throws(() => parseRemoteUrl("http://localhost:8787"), /must use HTTPS/);
  assert.throws(() => parseRemoteUrl("https://operator.example/api"), /only an origin/);
  assert.throws(() => parseRemoteUrl("https://token@operator.example"), /only an origin/);
});

test("remote route policy permits every documented console route and rejects near misses", () => {
  const project = "project_12345678";
  const run = "run_12345678";
  const workflow = "release";
  const job = "proposal-123e4567-e89b-12d3-a456-426614174000";
  const revision = "4";
  const allowed = [
    ["GET", "/api/v1/projects"],
    ["GET", `/api/v1/projects/${project}/execution-profiles`],
    ["GET", `/api/v1/projects/${project}/runs?cursor=1&limit=20`],
    ["POST", `/api/v1/projects/${project}/runs?limit=20`],
    ["GET", `/api/v1/projects/${project}/runs/${run}`],
    ["GET", `/api/v1/projects/${project}/runs/${run}/events?after=2&limit=20`],
    ["GET", `/api/v1/projects/${project}/runs/${run}/events/stream?after=2`],
    ...["stop", "resume", "interrupt", "checkpoint-decision", "cleanup"].map((action) => [
      "POST",
      `/api/v1/projects/${project}/runs/${run}/${action}`,
    ]),
    ["GET", `/api/v1/projects/${project}/workflows`],
    ["GET", `/api/v1/projects/${project}/workflows/templates`],
    ["POST", `/api/v1/projects/${project}/workflows/templates`],
    ["GET", `/api/v1/projects/${project}/workflows/${workflow}`],
    ["POST", `/api/v1/projects/${project}/workflows/${workflow}/analysis`],
    ["POST", `/api/v1/projects/${project}/workflows/${workflow}/proposals`],
    ["GET", `/api/v1/projects/${project}/workflows/${workflow}/proposals/${job}`],
    ["POST", `/api/v1/projects/${project}/workflows/${workflow}/drafts`],
    ["GET", `/api/v1/projects/${project}/workflows/${workflow}/diff?from=2&to=3`],
    ...["validate", "activate"].map((action) => [
      "POST",
      `/api/v1/projects/${project}/workflows/${workflow}/revisions/${revision}/${action}`,
    ]),
  ];
  for (const [method, requestPath] of allowed) {
    const url = new URL(requestPath, "http://127.0.0.1");
    assert.equal(isAllowedRemoteRequest(method, url.pathname, url.searchParams), true, requestPath);
  }

  const rejected = [
    ["DELETE", "/api/v1/projects"],
    ["GET", `/api/v1/projects/${project}/runs?cursor=1&cursor=2`],
    ["GET", `/api/v1/projects/${project}/runs/${run}/events/stream?limit=1`],
    ["POST", `/api/v1/projects/${project}/runs/${run}/publish`],
    ["GET", `/api/v1/projects/${project}/workflows/${workflow}/proposals/not-a-job`],
    ["GET", `/api/v1/projects/${project}/workflows/${workflow}/analysis`],
    ["POST", `/api/v1/projects/${project}/workflows/${workflow}/revisions/0/activate`],
    ["POST", `/api/v1/projects/${project}/workflows/${workflow}/revisions/4/delete`],
    ["GET", "/api/v1/admin/export"],
  ];
  for (const [method, requestPath] of rejected) {
    const url = new URL(requestPath, "http://127.0.0.1");
    assert.equal(
      isAllowedRemoteRequest(method, url.pathname, url.searchParams),
      false,
      requestPath,
    );
  }
});

test("upstream token files must be regular, current-owner, and private", () => {
  const fixture = tokenFixture();
  assert.equal(readRemoteTokenFile(fixture.path), "upstream-token");
  chmodSync(fixture.path, 0o640);
  assert.throws(() => readRemoteTokenFile(fixture.path), /token file is unsafe/);
  chmodSync(fixture.path, 0o600);
  const symlink = join(fixture.directory, "token-link");
  symlinkSync(fixture.path, symlink);
  assert.throws(
    () => readRemoteTokenFile(symlink),
    /token file is unavailable|token file is unsafe/,
  );
});

test("remote proxy re-reads the server-side token and rejects routes outside the UI allowlist", async () => {
  const fixture = tokenFixture("first-upstream-token");
  const calls = [];
  const proxy = createRemoteOperatorProxy({
    remoteUrl: "https://operator.example",
    tokenFile: fixture.path,
    fetchImpl: async (target, options) => {
      calls.push({ target: target.toString(), options });
      return new Response('{"projects":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const url = new URL("/api/v1/projects", "http://127.0.0.1:4173");
  const first = await proxy.forward(new MockRequest(), url);
  assert.equal(first.status, 200);
  assert.equal(first.body.toString("utf8"), '{"projects":[]}');
  assert.equal(calls[0].target, "https://operator.example/api/v1/projects");
  assert.equal(calls[0].options.headers.authorization, "Bearer first-upstream-token");
  writeFileSync(fixture.path, "rotated-upstream-token\n", { mode: 0o600 });
  await proxy.forward(new MockRequest(), url);
  assert.equal(calls[1].options.headers.authorization, "Bearer rotated-upstream-token");

  await assert.rejects(
    proxy.forward(new MockRequest(), new URL("/api/v1/admin/export", "http://127.0.0.1:4173")),
    /path is not allowed/,
  );
  assert.equal(calls.length, 2);
});

test("remote proxy rejects redirects without reflecting an upstream token", async () => {
  const fixture = tokenFixture("not-for-errors");
  const proxy = createRemoteOperatorProxy({
    remoteUrl: "https://operator.example",
    tokenFile: fixture.path,
    fetchImpl: async () =>
      new Response("redirect", { status: 302, headers: { location: "/other" } }),
  });
  await assert.rejects(
    proxy.forward(new MockRequest(), new URL("/api/v1/projects", "http://127.0.0.1:4173")),
    (error) => error.status === 502 && !error.message.includes("not-for-errors"),
  );
});

test("remote proxy bounds request and response bodies before they reach the browser", async () => {
  const fixture = tokenFixture();
  let calls = 0;
  const proxy = createRemoteOperatorProxy({
    remoteUrl: "https://operator.example",
    tokenFile: fixture.path,
    fetchImpl: async () => {
      calls += 1;
      return new Response(Buffer.alloc(MAX_REMOTE_RESPONSE_BYTES + 1), { status: 200 });
    },
  });
  await assert.rejects(
    proxy.forward(
      new MockRequest({
        method: "POST",
        headers: { "content-length": String(64 * 1024 + 1) },
        body: "{}",
      }),
      new URL("/api/v1/projects/project_12345678/runs", "http://127.0.0.1:4173"),
    ),
    (error) => error.status === 413,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    proxy.forward(new MockRequest(), new URL("/api/v1/projects", "http://127.0.0.1:4173")),
    /response exceeds size limit/,
  );
  assert.equal(calls, 1);
});
