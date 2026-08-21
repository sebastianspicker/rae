/** Verifies loopback authentication, project confinement, and input-size defenses. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  canonicalGitRoot,
  createProjectRegistry,
  createSessionToken,
  findProject,
  isAuthorized,
  readJsonBody,
  validateLoopbackRequest,
  validateRunId,
} from "../lib/security.mjs";
import {
  createRemoteOperatorProxy,
  isAllowedRemoteRequest,
  parseRemoteUrl,
  readRemoteTokenFile,
} from "../lib/remote.mjs";

test("session tokens contain 256 bits of entropy and require exact bearer equality", () => {
  const token = createSessionToken();
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(`Bearer ${token}x`, token), false);
  assert.equal(isAuthorized(token, token), false);
});

test("project registry accepts only canonical Git top-level roots and exposes opaque ids", () => {
  const root = mkdtempSync(join(tmpdir(), "rae-operator-project-"));
  execFileSync("git", ["init", "-q", root]);
  const projects = createProjectRegistry([root]);
  assert.equal(projects[0].root, canonicalGitRoot(root));
  assert.doesNotMatch(projects[0].id, /rae-operator-project/);
  assert.equal(findProject(projects, projects[0].id), projects[0]);
  assert.equal(findProject(projects, "../../escape"), null);
});

test("loopback validation requires exact Host and state-changing Origin", () => {
  const expected = { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" };
  assert.deepEqual(
    validateLoopbackRequest(
      { headers: { host: expected.host, origin: expected.origin } },
      { ...expected, requireOrigin: true },
    ),
    { ok: true },
  );
  assert.equal(
    validateLoopbackRequest(
      { headers: { host: "localhost:4173", origin: expected.origin } },
      expected,
    ).status,
    421,
  );
  assert.equal(
    validateLoopbackRequest(
      { headers: { host: expected.host } },
      { ...expected, requireOrigin: true },
    ).status,
    403,
  );
});

test("JSON body parsing is bounded and object-only", async () => {
  const request = Readable.from([Buffer.from('{"task":"safe"}')]);
  request.headers = { "content-length": "15" };
  assert.deepEqual(await readJsonBody(request), { task: "safe" });

  const oversized = Readable.from([Buffer.alloc(65 * 1024)]);
  oversized.headers = {};
  await assert.rejects(readJsonBody(oversized), (error) => error.status === 413);

  const array = Readable.from([Buffer.from("[]")]);
  array.headers = {};
  await assert.rejects(readJsonBody(array), (error) => error.status === 400);
});

test("run ids cannot contain separators or traversal", () => {
  assert.equal(validateRunId("run-2026-07-17_01"), "run-2026-07-17_01");
  assert.throws(() => validateRunId("../run"), /invalid run id/);
  assert.throws(() => validateRunId("a/b"), /invalid run id/);
});

test("remote operator forwarding is origin-bound and allows only explicit safe routes", async () => {
  assert.equal(parseRemoteUrl("https://operator.example/").origin, "https://operator.example");
  for (const value of [
    "http://127.0.0.1/",
    "https://operator.example/api",
    "https://token@operator.example/",
    "https://operator.example/?token=leak",
  ]) {
    assert.throws(() => parseRemoteUrl(value), /origin|HTTPS/);
  }
  assert.equal(isAllowedRemoteRequest("GET", "/api/v1/projects", new URLSearchParams()), true);
  assert.equal(isAllowedRemoteRequest("GET", "/api/v1/projects", new URLSearchParams("next=x")), false);
  assert.equal(isAllowedRemoteRequest("POST", "/admin", new URLSearchParams()), false);

  const directory = mkdtempSync(join(tmpdir(), "rae-operator-token-"));
  const tokenFile = join(directory, "token");
  writeFileSync(tokenFile, "operator-secret\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  assert.equal(readRemoteTokenFile(tokenFile), "operator-secret");
  chmodSync(tokenFile, 0o644);
  assert.throws(() => readRemoteTokenFile(tokenFile), /unsafe/);
  chmodSync(tokenFile, 0o600);
  const tokenLink = join(directory, "token-link");
  symlinkSync(tokenFile, tokenLink);
  assert.throws(() => readRemoteTokenFile(tokenLink), /unsafe/);

  const requests = [];
  const proxy = createRemoteOperatorProxy({
    remoteUrl: "https://operator.example/",
    tokenFile,
    fetchImpl: async (target, options) => {
      requests.push({ target, options });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  const request = Readable.from([]);
  request.method = "GET";
  request.headers = {};
  await proxy.forward(request, new URL("http://127.0.0.1/api/v1/projects"));
  assert.equal(requests[0].target.origin, "https://operator.example");
  assert.equal(requests[0].options.headers.authorization, "Bearer operator-secret");
  assert.equal(requests[0].options.redirect, "manual");

  const redirectingProxy = createRemoteOperatorProxy({
    remoteUrl: "https://operator.example/",
    tokenFile,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }),
  });
  await assert.rejects(
    redirectingProxy.forward(request, new URL("http://127.0.0.1/api/v1/projects")),
    /redirect rejected/,
  );
});
