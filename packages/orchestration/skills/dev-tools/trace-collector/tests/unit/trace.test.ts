/**
 * Exercises trace loading and containment checks so collector inputs cannot escape the workspace.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTrace } from "../../src/lib/trace.js";
import { writeTraceSchema } from "./trace-test-helpers.js";

function removeWorkspace(workspaceRoot: string): void {
  rmSync(workspaceRoot, { recursive: true, force: true });
}

function writeValidTrace(traceDir: string): void {
  const trace = [
    { ts: "2026-02-22T12:00:00Z", run_id: "run-1", event: "phase_start", phase: "design", activity_id: "design_synthesis", tier: "balanced", model_hint: "design-synthesizer", runtime_name: "default", runtime_version: "v1" },
    { ts: "2026-02-22T12:00:02Z", run_id: "run-1", event: "gate_result", phase: "design", status: "pass" },
    { ts: "2026-02-22T12:00:05Z", run_id: "run-1", event: "phase_end", phase: "design", tokens_in: 100, tokens_out: 50, cost_usd: 0.25 },
  ];
  writeFileSync(join(traceDir, "trace.jsonl"), trace.map((event) => JSON.stringify(event)).join("\n"), "utf8");
}

async function collectValidTrace(workspaceRoot: string) {
  return collectTrace({ run_id: "run-1", trace_path: ".pipeline/runs/run-1/trace.jsonl", schema_ref: "contracts/artifacts/execution-trace.schema.json" }, [], { workspaceRoot });
}

function expectValidTraceSummary(result: Awaited<ReturnType<typeof collectTrace>>): void {
  expect(result.valid).toBe(true);
  expect(result.summary.total_events).toBe(3);
  expect(result.summary.gate_results.pass).toBe(1);
  expect(result.summary.total_tokens_in).toBe(100);
  expect(result.summary.total_tokens_out).toBe(50);
  expect(result.summary.total_cost_usd).toBe(0.25);
  expect(result.summary.phase_durations_ms.design).toBe(5000);
  expect(result.summary.total_duration_s).toBe(5);
  expect(result.summary.summed_phase_duration_s).toBe(result.summary.total_duration_s);
  expect(result.summary.activity_resolutions).toEqual([{ activity_id: "design_synthesis", count: 1, tier: "balanced", model_hint: "design-synthesizer", runtime_name: "default", runtime_version: "v1" }]);
}

function writeSingleTraceEvent(traceDir: string, runId: string): void {
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, "trace.jsonl"), JSON.stringify({ ts: "2026-02-22T12:00:00Z", run_id: runId, event: "phase_start", phase: "arm" }), "utf8");
}

function createSymlinkOrSkip(source: string, target: string, roots: string[]): boolean {
  try {
    symlinkSync(source, target);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "EPERM") throw err;
    roots.forEach(removeWorkspace);
    return false;
  }
}

async function expectSchemaSymlinkRejected(workspaceRoot: string): Promise<void> {
  const traceDir = join(workspaceRoot, ".pipeline", "runs", "run-4");
  writeSingleTraceEvent(traceDir, "run-4");
  const outsideRoot = mkdtempSync(join(tmpdir(), "trace-collector-outside-schema-"));
  const outsideSchema = join(outsideRoot, "execution-trace.schema.json");
  writeFileSync(outsideSchema, JSON.stringify({ type: "object" }), "utf8");
  const contractsDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(contractsDir, { recursive: true });
  if (!createSymlinkOrSkip(outsideSchema, join(contractsDir, "execution-trace.schema.json"), [workspaceRoot, outsideRoot])) return;
  await expect(collectTrace({ run_id: "run-4", trace_path: ".pipeline/runs/run-4/trace.jsonl", schema_ref: "contracts/artifacts/execution-trace.schema.json" }, [], { workspaceRoot })).rejects.toThrow("Path must resolve within schema root");
  removeWorkspace(workspaceRoot);
  removeWorkspace(outsideRoot);
}

describe("collectTrace", () => {
  it("validates events and aggregates summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-"));
    const traceDir = join(workspaceRoot, ".pipeline", "runs", "run-1");
    mkdirSync(traceDir, { recursive: true });
    writeTraceSchema(workspaceRoot);
    writeValidTrace(traceDir);
    expectValidTraceSummary(await collectValidTrace(workspaceRoot));
    removeWorkspace(workspaceRoot);
  });

  it("reports unmatched phase starts/ends as issues", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-issue-"));
    writeTraceSchema(workspaceRoot);

    const result = await collectTrace(
      {
        run_id: "run-2",
        schema_ref: "contracts/artifacts/execution-trace.schema.json",
        events: [
          {
            ts: "2026-02-22T12:00:00Z",
            run_id: "run-2",
            event: "phase_start",
            phase: "plan",
          },
        ],
      },
      [],
      { workspaceRoot },
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.includes("phase_start without matching phase_end")),
    ).toBe(true);

    removeWorkspace(workspaceRoot);
  });

  it("reports invalid wall-clock timestamps instead of emitting bad durations", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-wallclock-invalid-"));
    writeTraceSchema(workspaceRoot);

    const result = await collectTrace(
      {
        run_id: "run-invalid-wallclock",
        schema_ref: "contracts/artifacts/execution-trace.schema.json",
        events: [
          {
            ts: "not-a-timestamp",
            run_id: "run-invalid-wallclock",
            event: "run_start",
            phase: "arm",
          },
          {
            ts: "2026-02-22T12:00:05Z",
            run_id: "run-invalid-wallclock",
            event: "run_end",
            phase: "release-readiness",
          },
        ],
      },
      [],
      { workspaceRoot },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("invalid run_start or run_end timestamp");
    expect(result.summary.total_wall_clock_s).toBeUndefined();

    removeWorkspace(workspaceRoot);
  });

  it("reports reversed wall-clock timestamps", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-wallclock-reversed-"));
    writeTraceSchema(workspaceRoot);

    const result = await collectTrace(
      {
        run_id: "run-reversed-wallclock",
        schema_ref: "contracts/artifacts/execution-trace.schema.json",
        events: [
          {
            ts: "2026-02-22T12:00:10Z",
            run_id: "run-reversed-wallclock",
            event: "run_start",
            phase: "arm",
          },
          {
            ts: "2026-02-22T12:00:05Z",
            run_id: "run-reversed-wallclock",
            event: "run_end",
            phase: "release-readiness",
          },
        ],
      },
      [],
      { workspaceRoot },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("run_end precedes run_start");
    expect(result.summary.total_wall_clock_s).toBeUndefined();

    removeWorkspace(workspaceRoot);
  });

  it("rejects trace_path symlinks that resolve outside workspaceRoot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-symlink-trace-"));
    writeTraceSchema(workspaceRoot);

    const outsideRoot = mkdtempSync(join(tmpdir(), "trace-collector-outside-trace-"));
    const outsideTrace = join(outsideRoot, "trace.jsonl");
    writeFileSync(
      outsideTrace,
      JSON.stringify({
        ts: "2026-02-22T12:00:00Z",
        run_id: "run-3",
        event: "phase_start",
        phase: "arm",
      }),
      "utf8",
    );

    const symlinkPath = join(workspaceRoot, "trace-link.jsonl");
    try {
      symlinkSync(outsideTrace, symlinkPath);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "EPERM") {
        removeWorkspace(workspaceRoot);
        removeWorkspace(outsideRoot);
        return;
      }
      throw err;
    }

    await expect(
      collectTrace(
        {
          run_id: "run-3",
          trace_path: "trace-link.jsonl",
          schema_ref: "contracts/artifacts/execution-trace.schema.json",
        },
        [],
        { workspaceRoot },
      ),
    ).rejects.toThrow("Path must resolve within workspace root");

    removeWorkspace(workspaceRoot);
    removeWorkspace(outsideRoot);
  });

  it("rejects schema_ref symlinks that resolve outside workspaceRoot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-symlink-schema-"));
    await expectSchemaSymlinkRejected(workspaceRoot);
  });
});
