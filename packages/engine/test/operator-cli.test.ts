/** Exercises the local operator CLI without starting a provider-backed run. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, setRunStatus } from "../src/run/operator-control.js";
import { autonomousEntrypoint, executionRuntimeCwd } from "../src/public/index.js";
import type { SpawnSyncReturns } from "node:child_process";

const AUTONOMOUS = autonomousEntrypoint();
const PACKAGE_ROOT = executionRuntimeCwd();
const roots: string[] = [];

function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (proc.status !== 0) {
    throw new Error(`${command} failed (${proc.status}):\n${proc.stderr}\n${proc.stdout}`);
  }
  return proc;
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "rae operator cli "));
  roots.push(root);
  run("git", ["init", "-b", "main"], root);
  const runDir = join(root, ".pipeline", "runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(root, ".pipeline", "pipeline-state.json"),
    `${JSON.stringify({ run_id: "run-1", completed_gates: [] }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(runDir, "trace.jsonl"),
    `${JSON.stringify({
      ts: "2026-07-17T08:00:00.000Z",
      run_id: "run-1",
      event: "run_start",
      phase: "arm",
      status: "ok",
    })}\n`,
    "utf8",
  );
  return root;
}

function control(root: string, command: string, ...args: string[]): SpawnSyncReturns<string> {
  return run(
    process.execPath,
    [AUTONOMOUS, command, "--project-root", root, "--run-id", "run-1", "--json", ...args],
    PACKAGE_ROOT,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("autonomous operator CLI reports status, pages projected events, and persists idempotent stop requests", {
  timeout: 15_000,
}, () => {
  const root = createWorkspace();
  const status = JSON.parse(control(root, "status").stdout);
  assert.equal(status.run_id, "run-1");
  assert.equal(status.active_lock, false);
  assert.equal(status.operator_control.status, "running");

  const firstPage = JSON.parse(control(root, "events", "--limit", "1").stdout);
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.events[0].seq, 1);
  assert.equal(firstPage.events[0].event, "run_start");
  assert.equal(Object.hasOwn(firstPage.events[0], "message"), false);

  assert.equal(JSON.parse(control(root, "stop").stdout).operator_control.status, "stop-requested");
  control(root, "stop");
  const events = JSON.parse(control(root, "events").stdout).events;
  assert.equal(
    events.filter((event: Record<string, unknown>) => event.event === "run_stop_requested").length,
    1,
  );
});

test("autonomous operator CLI resolves opaque checkpoints with attributable rationale", {
  timeout: 15_000,
}, () => {
  const root = createWorkspace();
  const checkpoint = createCheckpoint(
    "run-1",
    { phase: "build", purpose: "mutation", message: "Review mutation." },
    root,
  );
  setRunStatus("run-1", "waiting", root, {
    waiting_checkpoint_id: checkpoint.checkpoint_id,
  });

  const result = JSON.parse(
    control(
      root,
      "resolve-checkpoint",
      "--checkpoint-id",
      checkpoint.checkpoint_id,
      "--decision",
      "approved",
      "--decision-id",
      "decision-1",
      "--actor",
      "local-operator",
      "--rationale",
      "Owned paths and verification plan were reviewed.",
    ).stdout,
  );
  assert.equal(result.checkpoint.checkpoint_id, checkpoint.checkpoint_id);
  assert.equal(result.checkpoint.status, "approved");
  assert.equal(result.checkpoint.decision.decision_id, "decision-1");
  assert.equal(result.checkpoint.decision.actor, "local-operator");
  assert.equal(
    result.checkpoint.decision.rationale,
    "Owned paths and verification plan were reviewed.",
  );

  const stored = JSON.parse(
    readFileSync(
      join(root, ".pipeline", "runs", "run-1", "checkpoints", `${checkpoint.checkpoint_id}.json`),
      "utf8",
    ),
  );
  assert.equal(stored.status, "approved");
});
