/** Verifies the console controller cannot exceed its owned process and run scope. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RunController, requireTypedConfirmation, validateStartInput } from "../lib/control.mjs";
import { createCheckpoint, setRunStatus } from "../../scripts/pipeline/lib/operator-control.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
    this.signals = [];
    this.pid = 4321;
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

test("start input permits only task and checkpoint policy", () => {
  assert.deepEqual(validateStartInput({ task: " Fix it ", checkpoint_policy: "before-mutation" }), {
    task: "Fix it",
    checkpointPolicy: "before-mutation",
  });
  assert.throws(
    () => validateStartInput({ task: "x", provider: "command" }),
    /unsupported start field/,
  );
  assert.throws(
    () => validateStartInput({ task: "x", env: { SECRET: "value" } }),
    /unsupported start field/,
  );
  assert.throws(() => validateStartInput({ task: "" }), /task is required/);
});

test("start input accepts a profile only after server-side resolution", () => {
  const profile = { source: "/private/operator-profile.json" };
  assert.equal(
    validateStartInput({ task: "safe", execution_profile_id: "local-codex" }, profile)
      .executionProfile,
    profile,
  );
  assert.throws(
    () => validateStartInput({ task: "safe", execution_profile_id: "../../private" }),
    /preloaded execution profile/,
  );
});

test("typed confirmation must match the exact run id", () => {
  assert.doesNotThrow(() => requireTypedConfirmation({ confirm_run_id: "run-1" }, "run-1"));
  assert.throws(
    () => requireTypedConfirmation({ confirm_run_id: "run-2" }, "run-1"),
    /does not match/,
  );
});

test("controller starts fixed Codex argv without a shell and owns only the newly discovered run", () => {
  const calls = [];
  const child = new FakeChild();
  const previousSecret = process.env.RAE_TEST_UNKNOWN_SECRET;
  process.env.RAE_TEST_UNKNOWN_SECRET = "must-not-reach-child";
  let discovery = [{ id: "old-run" }];
  const controller = new RunController({
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    discoverRunsFn() {
      return discovery;
    },
  });
  const project = { id: "project_12345678", root: "/repo" };
  const started = controller.start(project, { task: "Implement safely" });
  if (previousSecret === undefined) delete process.env.RAE_TEST_UNKNOWN_SECRET;
  else process.env.RAE_TEST_UNKNOWN_SECRET = previousSecret;
  assert.equal(started.accepted, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.RAE_TEST_UNKNOWN_SECRET, undefined);
  assert.equal(calls[0].options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "codex_cli_rs");
  assert.ok(calls[0].args.includes("codex"));
  assert.ok(!calls[0].args.includes("command"));
  assert.ok(!calls[0].args.includes("--in-place"));
  discovery = [{ id: "old-run" }, { id: "new-run" }];
  assert.equal(controller.refreshOwnership(), "new-run");
  assert.throws(() => controller.start(project, { task: "second" }), /already active/);
});

test("controller passes only the resolved execution-profile source to the fixed argv", () => {
  const child = new FakeChild();
  const calls = [];
  const controller = new RunController({
    spawnFn(command, args) {
      calls.push({ command, args });
      return child;
    },
    discoverRunsFn: () => [],
  });
  controller.start(
    { id: "project_12345678", root: "/repo" },
    { task: "Use the bounded profile", execution_profile_id: "local-codex" },
    { source: "/private/operator-profile.json" },
  );
  const index = calls[0].args.indexOf("--execution-profile");
  assert.equal(calls[0].args[index + 1], "/private/operator-profile.json");
  assert.equal(calls[0].args.includes("local-codex"), false);
});

test("interrupt signals only the exact active child and persists interrupted state", (t) => {
  const child = new FakeChild();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "rae-operator-interrupt-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspaceRoot]);
  const run = { id: "owned-run", workspaceRoot, current_phase: "build" };
  const runDir = join(workspaceRoot, ".pipeline", "runs", run.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "autonomous.lock"),
    `${JSON.stringify({ pid: child.pid, started_at: "2026-07-17T10:00:00.000Z" })}\n`,
  );
  writeFileSync(
    join(runDir, "trace.jsonl"),
    `${JSON.stringify({
      ts: "2026-07-17T10:00:00.000Z",
      run_id: run.id,
      event: "run_start",
      phase: "arm",
      status: "ok",
    })}\n`,
  );
  setRunStatus(run.id, "running", workspaceRoot);
  let discoveryCount = 0;
  const controller = new RunController({
    spawnFn: () => child,
    discoverRunsFn: () => (discoveryCount++ === 0 ? [] : [run]),
    locateRunFn: () => run,
  });
  const project = { id: "project_12345678", root: "/repo" };
  controller.start(project, { task: "Implement safely" });
  controller.refreshOwnership();
  assert.throws(
    () => controller.interrupt(project, "owned-run", { confirm_run_id: "wrong" }),
    /does not match/,
  );
  assert.deepEqual(controller.interrupt(project, "owned-run", { confirm_run_id: "owned-run" }), {
    accepted: true,
    run_id: "owned-run",
    signal: "SIGINT",
    containment_uncertain: true,
  });
  assert.deepEqual(child.signals, ["SIGINT"]);
  child.exitCode = 130;
  child.emit("exit", 130, null);
  assert.equal(existsSync(join(runDir, "autonomous.lock")), false);
  assert.equal(
    JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8")).status,
    "interrupted",
  );
  assert.match(readFileSync(join(runDir, "trace.jsonl"), "utf8"), /"run_interrupted"/);
});

test("operator resume remains unavailable for command-provider runs", (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "rae-operator-command-resume-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", workspaceRoot]);
  const run = {
    id: "command-run",
    workspaceRoot,
    runtime_active: false,
    checkpoints: [],
    status: "blocked",
    phase_order: ["build"],
    completed_gates: [],
  };
  const runDir = join(workspaceRoot, ".pipeline", "runs", run.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "request.json"),
    `${JSON.stringify({
      provider: "command",
      agent: {
        provider: "command",
        command: "/test/provider",
        allow_unsafe_command_provider: true,
      },
    })}\n`,
  );
  const controller = new RunController({ locateRunFn: () => run });
  assert.throws(
    () => controller.resume({ id: "project_12345678", root: workspaceRoot }, run.id),
    /command-provider runs cannot be resumed/,
  );
});

function createCheckpointRun() {
  const root = mkdtempSync(join(tmpdir(), "rae-operator-checkpoint-"));
  execFileSync("git", ["init", "-q", root]);
  const runId = "checkpoint-run";
  const runDir = join(root, ".pipeline", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(root, ".pipeline", "pipeline-state.json"),
    `${JSON.stringify({
      run_id: runId,
      current_phase: "release-readiness",
      phase_order: ["release-readiness"],
      completed_gates: [],
      workspace: { mode: "main-repo", primary_repo_root: root },
    })}\n`,
  );
  writeFileSync(
    join(runDir, "request.json"),
    `${JSON.stringify({
      task: "Review release",
      provider: "codex",
      agent: { provider: "codex" },
      requested_at: "2026-07-17T10:00:00.000Z",
    })}\n`,
  );
  const checkpoint = createCheckpoint(
    runId,
    { phase: "release-readiness", purpose: "ship", message: "Review release evidence." },
    root,
  );
  setRunStatus(runId, "waiting", root, { waiting_checkpoint_id: checkpoint.checkpoint_id });
  return { root, runId, checkpoint };
}

test("checkpoint decisions use opaque ids, durable actor/rationale, idempotence, and conflict status", () => {
  const { root, runId, checkpoint } = createCheckpointRun();
  assert.match(checkpoint.checkpoint_id, /^checkpoint-[a-f0-9]{24}$/);

  const controller = new RunController();
  const project = { id: "project_12345678", root, label: root };
  const body = {
    checkpoint_id: checkpoint.checkpoint_id,
    decision: "approve",
    decision_id: "decision_12345678",
    rationale: "All projected gates and evidence have been reviewed.",
  };
  const resolved = controller.decideCheckpoint(project, runId, body);
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.decision.actor, "rae-loopback-operator");
  assert.equal(resolved.decision.rationale, body.rationale);
  assert.deepEqual(controller.decideCheckpoint(project, runId, body), resolved);
  assert.throws(
    () =>
      controller.decideCheckpoint(project, runId, {
        ...body,
        decision: "reject",
        decision_id: "decision_87654321",
      }),
    (error) => error.status === 409,
  );
});
