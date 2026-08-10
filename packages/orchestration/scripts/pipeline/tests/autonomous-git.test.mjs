/** Characterizes autonomous Git and runtime-namespace safety validation. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeNamespaceInvariant,
  runtimeNamespaceSnapshot,
  validateConcurrentControl,
  validateConcurrentTraceEvent,
} from "../lib/autonomous-git.mjs";

const roots = [];
const RUN_ID = "run-1";
const STOPPED_AT = "2026-07-17T10:00:01.000Z";
const beforeControl = {
  schema_version: "1.0.0",
  run_id: RUN_ID,
  status: "running",
  stop_requested: false,
  updated_at: "2026-07-17T10:00:00.000Z",
};

function stopControl(overrides = {}) {
  return {
    ...beforeControl,
    status: "stop-requested",
    stop_requested: true,
    stop_requested_at: STOPPED_AT,
    updated_at: STOPPED_AT,
    ...overrides,
  };
}

function stopTrace(overrides = {}) {
  return JSON.stringify({
    event: "run_stop_requested",
    phase: "build",
    run_id: RUN_ID,
    status: "ok",
    ts: STOPPED_AT,
    ...overrides,
  });
}

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "rae-autonomous-git-"));
  roots.push(root);
  const pipelineRoot = join(root, ".pipeline");
  mkdirSync(join(pipelineRoot, "runs"), { recursive: true });
  writeFileSync(join(pipelineRoot, "state.json"), "state\n");
  writeFileSync(join(pipelineRoot, "runs", "trace.jsonl"), "trace\n");
  symlinkSync("state.json", join(pipelineRoot, "state-link"));
  return { root, pipelineRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autonomous Git safety validation", () => {
  it("accepts only the unchanged or valid sticky-stop control state", () => {
    expect(() => validateConcurrentControl(beforeControl, beforeControl, RUN_ID)).not.toThrow();
    expect(() => validateConcurrentControl(beforeControl, stopControl(), RUN_ID)).not.toThrow();
  });

  it.each([
    ["wrong run", { run_id: "other-run" }],
    ["wrong status", { status: "completed" }],
    ["cleared stop", { stop_requested: false }],
    ["invalid timestamp", { stop_requested_at: "not-a-date" }],
    ["new stable field", { injected: true }],
    ["changed stable field", { schema_version: "2.0.0" }],
  ])("rejects an invalid control transition: %s", (_label, overrides) => {
    expect(() => validateConcurrentControl(beforeControl, stopControl(overrides), RUN_ID)).toThrow(
      /invalid operator-control transition/,
    );
  });

  it("accepts a schema-exact stop trace for the expected phase", () => {
    expect(() => validateConcurrentTraceEvent(stopTrace(), RUN_ID, "build")).not.toThrow();
  });

  it.each([
    ["extra key", { injected: true }],
    ["wrong event", { event: "run_completed" }],
    ["wrong run", { run_id: "other-run" }],
    ["wrong status", { status: "error" }],
    ["unknown phase", { phase: "unknown" }],
    ["unexpected phase", { phase: "verify" }],
    ["invalid timestamp", { ts: "not-a-date" }],
  ])("rejects an invalid stop trace: %s", (_label, overrides) => {
    expect(() => validateConcurrentTraceEvent(stopTrace(overrides), RUN_ID, "build")).toThrow(
      /non-stop operator trace event/,
    );
  });

  it("rejects malformed trace JSON", () => {
    expect(() => validateConcurrentTraceEvent("{", RUN_ID)).toThrow(/invalid trace JSON/);
  });
});

describe("runtime namespace snapshots", () => {
  it("captures files, directories, and symlinks while omitting allowed refs", () => {
    const { root } = runtimeFixture();
    const snapshot = runtimeNamespaceSnapshot(root, ["runs/trace.jsonl"]);

    expect(snapshot.get("runs")).toMatch(/^directory:/);
    expect(snapshot.has("runs/trace.jsonl")).toBe(false);
    expect(snapshot.get("state.json")).toMatch(/^file:/);
    expect(snapshot.get("state-link")).toMatch(/^symlink:.*:state\.json$/);
  });

  it("detects protected runtime mutations and permits declared changes", () => {
    const { root, pipelineRoot } = runtimeFixture();
    const before = runtimeNamespaceSnapshot(root);
    writeFileSync(join(pipelineRoot, "state.json"), "changed\n");

    expect(() => assertRuntimeNamespaceInvariant(before, root)).toThrow(
      /modified protected \.pipeline state: state\.json/,
    );
    expect(() => assertRuntimeNamespaceInvariant(before, root, ["state.json"])).not.toThrow();
  });
});
