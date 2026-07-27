/** Exercises the local operator CLI without starting a provider-backed run. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCheckpoint, setRunStatus } from "../lib/operator-control.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const AUTONOMOUS = join(PACKAGE_ROOT, "scripts/pipeline/autonomous.mjs");
const roots = [];

function run(command, args, cwd) {
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

function createWorkspace() {
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

function control(root, command, ...args) {
  return run(
    process.execPath,
    [AUTONOMOUS, command, "--project-root", root, "--run-id", "run-1", "--json", ...args],
    PACKAGE_ROOT,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autonomous operator CLI", () => {
  it("reports status, pages projected events, and persists idempotent stop requests", () => {
    const root = createWorkspace();
    const status = JSON.parse(control(root, "status").stdout);
    expect(status).toMatchObject({ run_id: "run-1", active_lock: false });
    expect(status.operator_control.status).toBe("running");

    const firstPage = JSON.parse(control(root, "events", "--limit", "1").stdout);
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.events[0]).toMatchObject({ seq: 1, event: "run_start" });
    expect(firstPage.events[0]).not.toHaveProperty("message");

    expect(JSON.parse(control(root, "stop").stdout).operator_control.status).toBe("stop-requested");
    control(root, "stop");
    const events = JSON.parse(control(root, "events").stdout).events;
    expect(events.filter((event) => event.event === "run_stop_requested")).toHaveLength(1);
  });

  it("resolves opaque checkpoints with attributable rationale", () => {
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
    expect(result.checkpoint).toMatchObject({
      checkpoint_id: checkpoint.checkpoint_id,
      status: "approved",
      decision: {
        decision_id: "decision-1",
        actor: "local-operator",
        rationale: "Owned paths and verification plan were reviewed.",
      },
    });

    const stored = JSON.parse(
      readFileSync(
        join(root, ".pipeline", "runs", "run-1", "checkpoints", `${checkpoint.checkpoint_id}.json`),
        "utf8",
      ),
    );
    expect(stored.status).toBe("approved");
  });
});
