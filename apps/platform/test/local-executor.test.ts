/** Hosted integration keeps provider writes outside workspace and awaits cancellation cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentPhaseOptions, ExecutionProfile } from "@rae/engine";
import { createLocalClaimExecutor, type ExecutorDependencies } from "../src/local-executor.js";
import { createPrivateStaging } from "../src/hosted-staging.js";
import type { Claim } from "../src/store-types.js";

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(tmpdir(), "rae-hosted-execution-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const otherRoot = path.join(base, "other-project");
  const home = path.join(base, "home");
  for (const directory of [root, otherRoot, home]) fs.mkdirSync(directory, { mode: 0o700 });
  const mapping = { model: "fixture-model", reasoning_effort: "medium" as const };
  const profile: ExecutionProfile = {
    schema_version: "2.0.0",
    profile_id: "fixture-profile",
    tiers: { economy: mapping, standard: mapping, judgment: mapping },
    capability_sets: { none: { web_search: "disabled", mcp_servers: [], credential_env_vars: [] } },
    default_capability_set: "none",
    node_capability_sets: { work: "none" },
  };
  const claim: Claim = {
    runId: "run",
    attemptId: "attempt",
    nodeId: "node",
    nodeKey: "work",
    projectId: "project",
    access: "write",
    fence: 1,
    leaseSeconds: 60,
    heartbeatSeconds: 20,
    payload: { prompt: "Fixture", outputSchema: { type: "object" }, profileDigest: "digest" },
  };
  let stagePath = "";
  let invocation: AgentPhaseOptions | undefined;
  const dependencies: ExecutorDependencies = {
    loadProjects: () =>
      new Map([
        ["project", { root, profile: "profile" }],
        ["other", { root: otherRoot, profile: "profile" }],
      ]),
    loadProfile: () => ({ profile, digest: "digest", source: "profile" }),
    stage: (roots) => {
      assert.deepEqual(roots, [root, otherRoot]);
      const stage = createPrivateStaging(home, roots);
      stagePath = stage.root;
      return stage;
    },
    run: async (options) => {
      invocation = options;
      assert.ok(options.outputPath && options.eventLogPath);
      fs.writeFileSync(options.outputPath, '{"ok":true}\n', { mode: 0o600 });
      fs.writeFileSync(options.eventLogPath, '{"type":"fixture"}\n', { mode: 0o600 });
      return { artifact: { ok: true }, durationMs: 3, provider: "codex" };
    },
  };
  return { root, claim, dependencies, stagePath: () => stagePath, invocation: () => invocation };
}

test("hosted execution uses private staging, exact capabilities and atomic publication", async (t) => {
  const f = fixture(t);
  const execute = createLocalClaimExecutor({ projectMapFile: "fixture" }, f.dependencies);
  const result = await execute(f.claim, new AbortController().signal);
  assert.deepEqual(result.artifact, { ok: true });
  const request = f.invocation();
  assert.ok(request);
  assert.equal(request.eventLogRoot, f.stagePath());
  assert.equal(request.schemaPath, path.join(f.stagePath(), "output.schema.json"));
  assert.equal(request.workspaceRoot, f.root);
  assert.deepEqual(request.capabilities, {
    name: "none",
    web_search: "disabled",
    mcp_servers: [],
    credential_env_vars: [],
  });
  assert.equal(fs.existsSync(f.stagePath()), false);
  const destination = path.join(f.root, ".pipeline/hosted-worker/run/attempt");
  assert.equal(fs.readFileSync(path.join(destination, "output.json"), "utf8"), '{"ok":true}\n');
  assert.equal(fs.statSync(path.join(destination, "events.jsonl")).mode & 0o777, 0o600);
});

test("lease cancellation awaits provider cleanup and publishes no artifacts", async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.dependencies.run = async (request) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.equal(request.signal?.aborted, true);
    throw new Error("contained after cancellation");
  };
  const execute = createLocalClaimExecutor({ projectMapFile: "fixture" }, f.dependencies);
  let settled = false;
  const running = execute(f.claim, abort.signal).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(running, /contained after cancellation/);
  await ready;
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(f.stagePath()), true);
  release();
  await rejected;
  assert.equal(fs.existsSync(f.stagePath()), false);
  assert.equal(
    fs.existsSync(path.join(f.root, ".pipeline/hosted-worker/run/attempt/output.json")),
    false,
  );
});

test("workspace directory replacement during provider work cannot redirect publication", async (t) => {
  const f = fixture(t);
  const run = f.dependencies.run;
  const outside = path.join(path.dirname(f.root), "outside");
  fs.mkdirSync(outside);
  f.dependencies.run = async (request) => {
    const result = await run(request);
    fs.renameSync(path.join(f.root, ".pipeline"), path.join(f.root, "moved"));
    fs.symlinkSync(outside, path.join(f.root, ".pipeline"));
    return result;
  };
  const execute = createLocalClaimExecutor({ projectMapFile: "fixture" }, f.dependencies);
  await assert.rejects(execute(f.claim, new AbortController().signal), /changed|symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(f.stagePath()), false);
});

test("invalid claims fail before staging or provider execution", async (t) => {
  const f = fixture(t);
  let called = false;
  f.dependencies.stage = () => {
    called = true;
    throw new Error("unexpected stage");
  };
  const execute = createLocalClaimExecutor({ projectMapFile: "fixture" }, f.dependencies);
  for (const claim of [
    { ...f.claim, nodeKey: "unmapped" },
    { ...f.claim, payload: { prompt: "Fixture", outputSchema: {}, profileDigest: "wrong" } },
    {
      ...f.claim,
      payload: {
        prompt: "Fixture",
        outputSchema: {},
        profileDigest: "digest",
        timeoutSeconds: "NaN",
      },
    },
  ])
    await assert.rejects(execute(claim, new AbortController().signal));
  assert.equal(called, false);
  assert.equal(fs.existsSync(path.join(f.root, ".pipeline")), false);
});
