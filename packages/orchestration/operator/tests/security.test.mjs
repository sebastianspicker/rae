/** Verifies loopback authentication, project confinement, and input-size defenses. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
