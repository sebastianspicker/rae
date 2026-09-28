/** Exercises the compiled HTTP catalogue and exact tail backpressure cursor contract. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createOperatorServer, writeTailEvents } from "../server.js";
import type { OperatorProject } from "../lib/security.js";
import type { OperatorRun } from "../static/js/types.js";

function projectFixture(t: TestContext): OperatorProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rae-operator-server-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".pipeline", "runs"), { recursive: true });
  writeFileSync(
    join(root, ".pipeline", "pipeline-state.json"),
    JSON.stringify({
      workspace: { primary_repo_root: root },
    }),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { id: "project_server_test", root, label: "server fixture" };
}

function addRun(project: OperatorProject, id: string, requestedAt: string): void {
  const directory = join(project.root, ".pipeline", "runs", id);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "request.json"),
    JSON.stringify({ task: id, requested_at: requestedAt }),
  );
  writeFileSync(
    join(directory, "operator-control.json"),
    JSON.stringify({ status: "completed", updated_at: requestedAt }),
  );
  writeFileSync(join(directory, "trace.jsonl"), "");
}

test("HTTP run listing uses opaque stable keysets and rejects malformed cursors", async (t) => {
  const project = projectFixture(t);
  addRun(project, "run-b", "2026-09-01T00:00:00Z");
  addRun(project, "run-a", "2026-09-01T00:00:00Z");
  const instance = createOperatorServer({ projects: [project], token: "test-token" });
  await new Promise<void>((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(0, "127.0.0.1", () => resolveListen());
  });
  t.after(() => new Promise<void>((resolveClose) => instance.server.close(() => resolveClose())));
  const address = instance.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1/projects/${project.id}/runs`;
  const headers = { authorization: "Bearer test-token" };
  const firstResponse = await fetch(`${base}?view=summary&limit=1`, { headers });
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as { runs: OperatorRun[]; next_cursor: string };
  assert.deepEqual(
    first.runs.map((run) => run.id),
    ["run-b"],
  );
  assert.doesNotMatch(first.next_cursor, /^\d+$/u);
  addRun(project, "run-new", "2026-09-02T00:00:00Z");
  const secondResponse = await fetch(
    `${base}?view=summary&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
    { headers },
  );
  const second = (await secondResponse.json()) as { runs: OperatorRun[] };
  assert.deepEqual(
    second.runs.map((run) => run.id),
    ["run-a"],
  );
  assert.equal((await fetch(`${base}?view=summary&cursor=invalid`, { headers })).status, 400);
});

test("tail writes advance through the accepted chunk and resume only after drain", () => {
  const writes: string[] = [];
  let drain: (() => void) | null = null;
  let resumes = 0;
  const delivery = writeTailEvents(
    {
      write(chunk) {
        writes.push(chunk);
        return false;
      },
      once(_event, listener) {
        drain = listener;
      },
    },
    [{ seq: 7 }, { seq: 8 }],
    6,
    () => {
      resumes += 1;
    },
  );
  assert.deepEqual(delivery, { acceptedThrough: 7, pause: true });
  assert.equal(writes.length, 1);
  assert.equal(resumes, 0);
  assert.ok(drain);
  (drain as () => void)();
  assert.equal(resumes, 1);
});

test("static serving exposes self-hosted fonts but not their licence texts", async (t) => {
  const project = projectFixture(t);
  const instance = createOperatorServer({ projects: [project], token: "test-token" });
  await new Promise<void>((resolveListen, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(0, "127.0.0.1", () => resolveListen());
  });
  t.after(() => new Promise<void>((resolveClose) => instance.server.close(() => resolveClose())));
  const address = instance.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const font = await fetch(`${origin}/fonts/plex-mono-400.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.match(font.headers.get("content-security-policy") ?? "", /font-src 'self'/u);
  await font.arrayBuffer();
  const licence = await fetch(`${origin}/fonts/OFL-IBMPlexMono.txt`);
  assert.equal(licence.status, 404);
  await licence.arrayBuffer();
});
