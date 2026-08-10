/** Purpose: source-unit contracts for the experimental hosted platform. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
import { runWorker } from "../src/worker.mjs";

async function requestPlatform(t, dependencies, path, options = {}) {
  const server = createPlatformServer(dependencies);
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, options);
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
  const originalFetch = globalThis.fetch;
  let heartbeatCalls = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/register")) return new Response("{}", { status: 200 });
    if (route.endsWith("/claim"))
      return Response.json({
        claim: {
          attemptId: "attempt",
          nodeId: "node",
          nodeKey: "work",
          fence: 1,
          heartbeatSeconds: 20,
        },
      });
    if (route.endsWith("/heartbeat")) {
      heartbeatCalls += 1;
      return new Response("{}", { status: 503 });
    }
    throw new Error(`unexpected worker route: ${route}`);
  };
  try {
    await runWorker({
      baseUrl: "https://control.example",
      token: "test-token",
      workerId: "worker",
      repositoryDigest: "a".repeat(64),
      worktreeDigest: "b".repeat(64),
      sleep: async () => {},
      execute: async (_claim, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(heartbeatCalls, 2);
});

test("worker rejects credential-bearing or ambiguous control-plane URLs", async () => {
  await assert.rejects(
    () =>
      runWorker({
        baseUrl: "https://user@example.test/?redirect=x",
        token: "token",
        workerId: "worker",
        repositoryDigest: "a".repeat(64),
        worktreeDigest: "b".repeat(64),
        execute: async () => ({}),
      }),
    /credential-free HTTPS control-plane origin/,
  );
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
