/** Purpose: source-unit contracts for the experimental hosted platform. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import { assertPublicHttpsUrl, classifyHost } from "../src/config.mjs";
import { createPlatformServer } from "../src/http.mjs";
import {
  assertStableProjectMapDescriptor,
  loadProjectMap,
  validateProjectMapEntry,
} from "../src/project-map.mjs";
import { MemoryStore, digest, MAX_ENVELOPE_BYTES } from "../src/store.mjs";
import { requireProject, requireScope } from "../src/authorization.mjs";
import { traceparent } from "../src/observability.mjs";
import { createWorkerRequest, runWorker } from "../src/worker.mjs";

async function requestPlatform(t, dependencies, path, options = {}) {
  const server = createPlatformServer(dependencies);
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

async function mcpRequest(t, dependencies, message) {
  const response = await requestPlatform(t, dependencies, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(message),
  });
  return { status: response.status, body: await response.json() };
}

function runRequestBody(projectId = "project") {
  return JSON.stringify({
    projectId,
    revision: { digest: "a".repeat(64), definition: {} },
    nodes: [],
    request: {},
  });
}

function authenticatedDependencies(principal, createRun = async () => ({ accepted: true })) {
  return {
    store: { createRun, isReady: async () => true },
    authenticate: async () => principal,
    logger: () => {},
    resourceBaseUrl: "https://platform.example",
  };
}

test("canonical revision digests are stable and upload rejects a wrong digest", async () => {
  const store = new MemoryStore();
  const document = { nodes: [{ id: "read" }] };
  const expected = digest(document);
  const saved = await store.uploadRevision({
    projectId: "project",
    kind: "workflow",
    document,
    expectedDigest: expected,
    idempotencyKey: "upload",
  });
  assert.equal(saved.digest, expected);
  await assert.rejects(
    () =>
      store.uploadRevision({
        projectId: "project",
        kind: "workflow",
        document,
        expectedDigest: "0".repeat(64),
        idempotencyKey: "wrong",
      }),
    { statusCode: 409 },
  );
});
test("runs require idempotency and limit envelopes to 256 KiB", async () => {
  const store = new MemoryStore();
  const input = {
    projectId: "project",
    revision: { digest: digest({}), definition: {} },
    nodes: [],
    request: {},
  };
  await assert.rejects(() => store.createRun(input), { statusCode: 400 });
  const one = await store.createRun({ ...input, idempotencyKey: "same" });
  const two = await store.createRun({ ...input, idempotencyKey: "same" });
  assert.deepEqual(one, two);
  await assert.rejects(
    () =>
      store.createRun({
        ...input,
        idempotencyKey: "large",
        request: { x: "x".repeat(MAX_ENVELOPE_BYTES) },
      }),
    { statusCode: 413 },
  );
});
test("worker registration, project authorization, run pinning, and four-reader writer exclusion hold", async () => {
  const store = new MemoryStore();
  const digest64 = "b".repeat(64);
  await store.registerWorker({
    workerId: "worker",
    repositoryDigest: digest64,
    worktreeDigest: digest64,
    projects: ["project"],
    idempotencyKey: "register",
  });
  await store.createRun({
    projectId: "project",
    revision: { digest: digest({}), definition: {} },
    repositoryDigest: digest64,
    worktreeDigest: digest64,
    nodes: [...Array(5)]
      .map((_, index) => ({ key: `r${index}`, access: "read" }))
      .concat({ key: "writer", access: "write" }),
    request: {},
    idempotencyKey: "run",
  });
  assert.equal(
    await store.claim({ workerId: "worker", projects: ["other"], idempotencyKey: "other" }),
    null,
  );
  const claims = await Promise.all(
    [...Array(5)].map((_, index) =>
      store.claim({ workerId: "worker", projects: ["project"], idempotencyKey: `claim-${index}` }),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 4);
  assert.equal(
    await store.claim({
      workerId: "worker",
      projects: ["project"],
      idempotencyKey: "writer-blocked",
    }),
    null,
  );
});
test("project and scope checks fail closed and traces are valid", () => {
  assert.throws(() => requireScope({ scopes: new Set() }, "rae.run.submit"), { statusCode: 403 });
  assert.throws(() => requireProject({ claims: { projects: ["other"] } }, "project"), {
    statusCode: 403,
  });
  assert.match(traceparent("bad"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
});

test("MCP run resources require rae.run.read before lookup and permit an explicit scope", async (t) => {
  const runId = "11111111-1111-4111-8111-111111111111";
  for (const [uri, events] of [
    [`rae://runs/${runId}`, false],
    [`rae://runs/${runId}/events`, true],
  ]) {
    let deniedLookups = 0;
    const denied = await mcpRequest(
      t,
      {
        store: {
          isReady: async () => true,
          getRun: async () => {
            deniedLookups += 1;
            return { id: runId, projectId: "project" };
          },
          listRunEvents: async () => [],
        },
        authenticate: async () => ({ scopes: new Set(), claims: { projects: ["project"] } }),
        logger: () => {},
        resourceBaseUrl: "https://platform.example",
      },
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } },
    );
    assert.equal(denied.status, 200);
    assert.match(denied.body.error.message, /missing required scope: rae\.run\.read/);
    assert.equal(deniedLookups, 0);

    const permitted = await mcpRequest(
      t,
      {
        store: {
          isReady: async () => true,
          getRun: async () => ({ id: runId, projectId: "project" }),
          listRunEvents: async () => [{ id: 1, kind: "created" }],
        },
        authenticate: async () => ({
          scopes: new Set(["rae.run.read"]),
          claims: { projects: ["project"] },
        }),
        logger: () => {},
        resourceBaseUrl: "https://platform.example",
      },
      { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } },
    );
    assert.equal(permitted.status, 200);
    const text = permitted.body.result.contents[0].text;
    assert.deepEqual(
      JSON.parse(text),
      events ? [{ id: 1, kind: "created" }] : { id: runId, projectId: "project" },
    );
  }
});

test("MCP submit rejects project fields in envelopes and binds submitted runs to project_id", async (t) => {
  const envelope = {
    revision: { digest: "a".repeat(64), definition: {} },
    nodes: [],
    request: {},
  };
  const submitted = [];
  const dependencies = {
    store: {
      isReady: async () => true,
      createRun: async (value) => {
        submitted.push(value);
        return value;
      },
    },
    authenticate: async () => ({
      scopes: new Set(["rae.run.submit"]),
      claims: { projects: ["project"] },
    }),
    logger: () => {},
    resourceBaseUrl: "https://platform.example",
  };
  const rejected = await mcpRequest(t, dependencies, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "rae_submit_run",
      arguments: {
        project_id: "project",
        envelope: { ...envelope, projectId: "other-project" },
        idempotency_key: "reject-project-override",
      },
    },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.result.isError, true);
  assert.match(rejected.body.result.content[0].text, /Unrecognized key: "projectId"/);
  assert.equal(submitted.length, 0);

  const accepted = await mcpRequest(t, dependencies, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "rae_submit_run",
      arguments: { project_id: "project", envelope, idempotency_key: "trusted-project" },
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.result.isError, undefined);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].projectId, "project");
});

test("revision diff requires membership in both revision projects before comparing them", async (t) => {
  const fromId = "22222222-2222-4222-8222-222222222222";
  const toId = "33333333-3333-4333-8333-333333333333";
  let diffCalls = 0;
  const store = {
    isReady: async () => true,
    getRevision: async (revisionId) =>
      revisionId === fromId
        ? { id: fromId, projectId: "project-a", kind: "workflow", digest: "a".repeat(64) }
        : { id: toId, projectId: "project-b", kind: "workflow", digest: "b".repeat(64) },
    diffRevisions: async () => {
      diffCalls += 1;
      return { from: "a".repeat(64), to: "b".repeat(64), changed: true };
    },
  };
  const response = await requestPlatform(
    t,
    {
      store,
      authenticate: async () => ({
        scopes: new Set(["rae.policy.write"]),
        claims: { projects: ["project-a"] },
      }),
      logger: () => {},
      resourceBaseUrl: "https://platform.example",
    },
    "/api/v2/revisions/diff",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromId, toId }),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(diffCalls, 0);

  const crossProject = await requestPlatform(
    t,
    {
      store,
      authenticate: async () => ({
        scopes: new Set(["rae.policy.write"]),
        claims: { projects: ["project-a", "project-b"] },
      }),
      logger: () => {},
      resourceBaseUrl: "https://platform.example",
    },
    "/api/v2/revisions/diff",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromId, toId }),
    },
  );
  assert.equal(crossProject.status, 404);
  assert.equal(diffCalls, 0);
});
test("fenced completion is idempotent and stale completion is rejected", async () => {
  const store = new MemoryStore();
  const stateDigest = "c".repeat(64);
  await store.registerWorker({
    workerId: "worker",
    repositoryDigest: stateDigest,
    worktreeDigest: stateDigest,
    projects: ["project"],
    idempotencyKey: "register-fence",
  });
  await store.createRun({
    projectId: "project",
    revision: { digest: digest({}), definition: {} },
    repositoryDigest: stateDigest,
    worktreeDigest: stateDigest,
    nodes: [{ key: "write", access: "write" }],
    request: {},
    idempotencyKey: "fenced-run",
  });
  const claim = await store.claim({
    workerId: "worker",
    projects: ["project"],
    idempotencyKey: "claim-fence",
  });
  const first = await store.report({
    workerId: "worker",
    nodeId: claim.nodeId,
    fence: claim.fence,
    outcome: "succeeded",
    idempotencyKey: "complete",
  });
  assert.deepEqual(
    await store.report({
      workerId: "worker",
      nodeId: claim.nodeId,
      fence: claim.fence,
      outcome: "succeeded",
      idempotencyKey: "complete",
    }),
    first,
  );
  await assert.rejects(
    () =>
      store.report({
        workerId: "worker",
        nodeId: claim.nodeId,
        fence: claim.fence,
        outcome: "failed",
        idempotencyKey: "contradict",
      }),
    { statusCode: 409 },
  );
});

test("worker aborts its child after two consecutive heartbeat failures", async () => {
  const originalRequest = https.request;
  let heartbeatCalls = 0;
  https.request = (target, _options, callback) => {
    const route = target.pathname;
    const request = new EventEmitter();
    request.end = () => {
      let status = 200;
      let body = "{}";
      if (route.endsWith("/claim")) {
        body = JSON.stringify({
          claim: {
            attemptId: "attempt",
            nodeId: "node",
            nodeKey: "work",
            fence: 1,
            heartbeatSeconds: 20,
          },
        });
      } else if (route.endsWith("/heartbeat")) {
        heartbeatCalls += 1;
        status = 503;
      } else if (!route.endsWith("/register")) {
        request.emit("error", new Error(`unexpected worker route: ${route}`));
        return;
      }
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = { "content-type": "application/json" };
      callback(response);
    };
    return request;
  };
  try {
    await runWorker({
      baseUrl: "https://control.example",
      token: "test-token",
      workerId: "worker",
      repositoryDigest: "a".repeat(64),
      worktreeDigest: "b".repeat(64),
      resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
      sleep: async () => {},
      execute: async (_claim, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    });
  } finally {
    https.request = originalRequest;
  }
  assert.equal(heartbeatCalls, 2);
});

test("worker rejects untrusted origins before fetch, including development-mode bypasses", async () => {
  let fetchCalls = 0;
  const options = {
    token: "token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}");
    },
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
  };
  for (const baseUrl of [
    "https://user@example.test/",
    "https://example.test/?redirect=x",
    "https://example.test/control",
    "http://example.test/",
  ]) {
    await assert.rejects(() => createWorkerRequest({ baseUrl, ...options }));
  }
  await assert.rejects(
    () => createWorkerRequest({ baseUrl: "http://192.168.1.10/", allowInsecureDevelopment: true, ...options }),
    /loopback-only|public addresses/,
  );
  assert.equal(fetchCalls, 0);
});

test("worker request locks a public endpoint and rejects authority-changing paths before fetch", async () => {
  const calls = [];
  let lookups = 0;
  const request = await createWorkerRequest({
    baseUrl: "https://control.example/",
    token: "test-token",
    resolveHostname: async () => {
      lookups += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ ok: true });
    },
  });
  for (const path of [
    "https://attacker.example/",
    "//attacker.example/",
    "api/v2/workers/register",
    "/api/v2/workers/register?target=attacker",
    "/api/v2/workers/register#attacker",
  ]) {
    await assert.rejects(() => request(path, {}, "blocked"), /endpoint-relative/);
  }
  assert.equal(calls.length, 0);
  await request("/api/v2/workers/register", { workerId: "worker" }, "register:worker");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: "https://control.example/api/v2/workers/register",
    options: {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "idempotency-key": "register:worker",
      },
      redirect: "error",
      body: '{"workerId":"worker"}',
      signal: calls[0].options.signal,
    },
  });
  assert.equal(lookups, 2);
});

test("worker revalidates DNS before fetch and permits only documented loopback development HTTP", async () => {
  let fetchCalls = 0;
  let lookupCalls = 0;
  const request = await createWorkerRequest({
    baseUrl: "https://control.example/",
    token: "token",
    resolveHostname: async () => {
      lookupCalls += 1;
      return [{ address: lookupCalls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });
  await assert.rejects(() => request("/api/v2/workers/claim", {}, "claim"), /public addresses/);
  assert.equal(fetchCalls, 0);
  const local = await createWorkerRequest({
    baseUrl: "http://127.0.0.1:8080/",
    token: "token",
    allowInsecureDevelopment: true,
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await local("/api/v2/workers/claim", {}, "claim");
});

test("worker pins the validated address in the HTTPS connection lookup", async () => {
  const originalRequest = https.request;
  const lookedUp = [];
  const transportTargets = [];
  try {
    https.request = (target, options, callback) => {
      transportTargets.push({ hostname: target.hostname, servername: options.servername });
      options.lookup("control.example", {}, (_error, address, family) => {
        lookedUp.push({ address, family });
      });
      const request = new EventEmitter();
      request.end = () => {
        const response = Readable.from([Buffer.from("{}")]);
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        callback(response);
      };
      return request;
    };
    let lookupCalls = 0;
    const request = await createWorkerRequest({
      baseUrl: "https://control.example/",
      token: "token",
      resolveHostname: async () => [{ address: ++lookupCalls === 1 ? "8.8.8.8" : "1.1.1.1" }],
    });
    await request("/api/v2/workers/claim", {}, "claim");
  } finally {
    https.request = originalRequest;
  }
  assert.deepEqual(lookedUp, [{ address: "1.1.1.1", family: 4 }]);
  assert.deepEqual(transportTargets, [{ hostname: "control.example", servername: "control.example" }]);
});

test("worker rejects redirects from the pinned transport before a second request", async () => {
  const originalRequest = https.request;
  let requests = 0;
  try {
    https.request = (_target, _options, callback) => {
      requests += 1;
      const request = new EventEmitter();
      request.end = () => {
        const response = Readable.from([]);
        response.statusCode = 302;
        response.headers = { location: "https://127.0.0.1/private" };
        callback(response);
      };
      return request;
    };
    const request = await createWorkerRequest({
      baseUrl: "https://control.example/",
      token: "token",
      resolveHostname: async () => [{ address: "8.8.8.8" }],
    });
    await assert.rejects(() => request("/api/v2/workers/claim", {}, "claim"), /redirects are forbidden/);
  } finally {
    https.request = originalRequest;
  }
  assert.equal(requests, 1);
});

test("host classifier rejects private OIDC targets while preserving public HTTPS endpoints", () => {
  for (const host of [
    "localhost",
    "service.internal",
    "10.0.0.1",
    "172.16.0.1",
    "[::1]",
    "fd00::1",
  ]) {
    assert.equal(classifyHost(host), "private", host);
  }
  assert.equal(classifyHost("oidc.example"), "public");
  assertPublicHttpsUrl("https://oidc.example/.well-known/openid-configuration", "OIDC issuer");
  assert.throws(
    () => assertPublicHttpsUrl("https://127.0.0.1/jwks", "OIDC JWKS URL"),
    /must not target a private or loopback address/,
  );
  assert.throws(
    () => assertPublicHttpsUrl("https://user@oidc.example/jwks?next=x", "OIDC JWKS URL"),
    /credential-free HTTPS URL without query or fragment/,
  );
});

test("authenticated HTTP routes fail closed before project-scoped idempotent storage calls", async (t) => {
  let calls = 0;
  const missingScope = await requestPlatform(
    t,
    authenticatedDependencies(
      { scopes: new Set(), claims: { projects: ["project"] } },
      async () => {
        calls += 1;
      },
    ),
    "/api/v2/runs",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "once" },
      body: runRequestBody(),
    },
  );
  assert.equal(missingScope.status, 403);
  assert.match(missingScope.headers.get("www-authenticate"), /insufficient_scope/);
  assert.equal(calls, 0);

  const missingProject = await requestPlatform(
    t,
    authenticatedDependencies({
      scopes: new Set(["rae.run.submit"]),
      claims: { projects: ["other"] },
    }),
    "/api/v2/runs",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "once" },
      body: runRequestBody(),
    },
  );
  assert.equal(missingProject.status, 403);
  assert.equal(calls, 0);

  const missingIdempotency = await requestPlatform(
    t,
    authenticatedDependencies(
      { scopes: new Set(["rae.run.submit"]), claims: { projects: ["project"] } },
      async () => {
        calls += 1;
      },
    ),
    "/api/v2/runs",
    { method: "POST", headers: { "content-type": "application/json" }, body: runRequestBody() },
  );
  assert.equal(missingIdempotency.status, 400);
  assert.equal(calls, 0);
});

test("project map keeps descriptor, no-follow, and canonical Git-root checks fail closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rae-platform-project-map-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repository");
  mkdirSync(root);
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  const profile = join(directory, "profile.json");
  const map = join(directory, "projects.toml");
  writeFileSync(profile, "{}\n", { mode: 0o600 });
  writeFileSync(map, `[projects.project]\nroot = "${root}"\nprofile = "${profile}"\n`, {
    mode: 0o600,
  });
  chmodSync(map, 0o600);
  assert.deepEqual(loadProjectMap(map).get("project"), {
    root: resolve(root),
    profile: resolve(profile),
  });
  assert.throws(
    () => validateProjectMapEntry("project", { root: "relative", profile }),
    /invalid project map entry: project/,
  );
  assert.throws(
    () =>
      assertStableProjectMapDescriptor({ dev: 1, ino: 2, size: 3 }, { dev: 1, ino: 4, size: 3 }),
    /project map changed while it was read/,
  );
  chmodSync(map, 0o644);
  assert.throws(() => loadProjectMap(map), /private owner-only regular file/);
  chmodSync(map, 0o600);
  const link = join(directory, "projects-link.toml");
  symlinkSync(map, link);
  assert.throws(() => loadProjectMap(link));
});
