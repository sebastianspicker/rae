/** Verifies durable run discovery exposes only the projected operator contract. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRuns, paginatedEvents, publicRun } from "../lib/runs.mjs";
import {
  createRuntimeStateGuard,
  runtimeStateGuardPath,
} from "../../scripts/pipeline/lib/runtime-state-guard.mjs";
import { runControlCommand } from "../../scripts/pipeline/lib/autonomous-actions.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createDiscoverableRun() {
  const root = mkdtempSync(join(tmpdir(), "rae-operator-runs-"));
  execFileSync("git", ["init", "-q", root]);
  const runId = "run-2026-07-17-0942";
  const runDir = join(root, ".pipeline", "runs", runId);
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeJson(join(root, ".pipeline", "pipeline-state.json"), {
    run_id: runId,
    current_phase: "quality-tests",
    phase_order: ["arm", "quality-tests", "release-readiness"],
    completed_gates: ["arm-gate"],
    workspace: { mode: "main-repo", primary_repo_root: root, branch: "pipeline/test" },
  });
  writeJson(join(runDir, "request.json"), {
    task: "Verify projected events\nprivate task continuation",
    requested_at: "2026-07-17T09:42:00.000Z",
  });
  writeJson(join(runDir, "operator-control.json"), {
    schema_version: "1.0.0",
    run_id: runId,
    status: "running",
    stop_requested: false,
    updated_at: "2026-07-17T09:43:00.000Z",
  });
  writeJson(join(runDir, "gates", "arm-gate.json"), {
    status: "pass",
    artifact_ref: "brief.json",
  });
  writeFileSync(
    join(runDir, "trace.jsonl"),
    `${JSON.stringify({
      event: "agent_call",
      phase: "quality-tests",
      status: "ok",
      ts: "2026-07-17T09:42:30.000Z",
      run_id: runId,
      tokens_in: 999,
      metadata: { provider: "private-provider", prompt: "must-not-leak" },
    })}\n`,
  );
  return { root, runId };
}

test("durable discovery projects run state without exposing raw trace metadata", () => {
  const { root, runId } = createDiscoverableRun();

  const project = { id: "project_12345678", root, label: root };
  const runs = discoverRuns(project);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].task, "Verify projected events");
  assert.equal(runs[0].current_phase, "quality-tests");
  assert.equal(publicRun(runs[0]).workspaceRoot, undefined);
  const page = paginatedEvents(runs[0], { after: 0, limit: 10 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].event, "agent_call");
  assert.equal(page.events[0].metadata, undefined);
  assert.equal(page.events[0].tokens_in, undefined);
  assert.doesNotMatch(JSON.stringify(page), /must-not-leak|private-provider/);
});

test("active guard discovery returns phase-active without consuming poisoned pipeline state", (t) => {
  const { root, runId } = createDiscoverableRun();
  t.after(() => {
    rmSync(runtimeStateGuardPath(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  createRuntimeStateGuard(root, runId, "build");
  writeFileSync(join(root, ".pipeline", "pipeline-state.json"), "poisoned\n");

  for (const command of ["status", "stop", "events", "resolve-checkpoint"]) {
    assert.throws(
      () => runControlCommand(command, { "project-root": root, "run-id": runId }),
      (error) => error.status === 409 && error.code === "E_PIPELINE_PHASE_ACTIVE",
    );
  }

  const [run] = discoverRuns({ id: "project_12345678", root, label: root });

  assert.equal(run.id, runId);
  assert.equal(run.status, "phase-active");
  assert.equal(run.current_phase, "build");
  assert.equal(run.guarded, true);
  assert.equal(publicRun(run).controls.stop, false);
  assert.throws(
    () => paginatedEvents(run),
    (error) => error.status === 409 && error.code === "E_PIPELINE_PHASE_ACTIVE",
  );
  assert.equal(readFileSync(join(root, ".pipeline", "pipeline-state.json"), "utf8"), "poisoned\n");
});

test("stale guard discovery restores state before normal run projection", (t) => {
  const { root, runId } = createDiscoverableRun();
  t.after(() => {
    if (existsSync(runtimeStateGuardPath(root))) {
      rmSync(runtimeStateGuardPath(root), { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });
  createRuntimeStateGuard(root, runId, "build");
  const guardPath = runtimeStateGuardPath(root);
  const manifestPath = join(guardPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeJson(manifestPath, { ...manifest, owner_pid: 999999 });
  writeFileSync(join(root, ".pipeline", "pipeline-state.json"), "poisoned\n");

  const [run] = discoverRuns({ id: "project_12345678", root, label: root });

  assert.equal(run.id, runId);
  assert.equal(run.task, "Verify projected events");
  assert.equal(run.guarded, undefined);
  assert.equal(existsSync(guardPath), false);
});
