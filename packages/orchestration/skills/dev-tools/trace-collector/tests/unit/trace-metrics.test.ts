import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAjvInstance } from "@coding-agents-space/shared";
import { collectTrace } from "../../src/lib/trace.js";

it("computes total_wall_clock_s from run_start and run_end events", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-wallclock-"));
  const schemaDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "execution-trace.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ts", "run_id", "event", "phase"],
      properties: {
        ts: { type: "string" },
        run_id: { type: "string" },
        event: { type: "string" },
        phase: { type: "string" },
      },
    }),
    "utf8",
  );

  const result = await collectTrace(
    {
      run_id: "run-wc",
      schema_ref: "contracts/artifacts/execution-trace.schema.json",
      events: [
        {
          ts: "2026-02-22T12:00:00Z",
          run_id: "run-wc",
          event: "run_start",
          phase: "",
        },
        {
          ts: "2026-02-22T12:00:01Z",
          run_id: "run-wc",
          event: "phase_start",
          phase: "design",
        },
        {
          ts: "2026-02-22T12:00:04Z",
          run_id: "run-wc",
          event: "phase_end",
          phase: "design",
        },
        {
          ts: "2026-02-22T12:00:10Z",
          run_id: "run-wc",
          event: "run_end",
          phase: "",
        },
      ],
    },
    [],
    { workspaceRoot },
  );

  expect(result.summary.total_wall_clock_s).toBe(10);
  expect(result.summary.summed_phase_duration_s).toBe(3);
  expect(result.summary.total_duration_s).toBe(3);

  rmSync(workspaceRoot, { recursive: true, force: true });
});

it("returns undefined for total_wall_clock_s when run_start/run_end are absent", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-nowc-"));
  const schemaDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "execution-trace.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ts", "run_id", "event", "phase"],
      properties: {
        ts: { type: "string" },
        run_id: { type: "string" },
        event: { type: "string" },
        phase: { type: "string" },
      },
    }),
    "utf8",
  );

  const result = await collectTrace(
    {
      run_id: "run-nowc",
      schema_ref: "contracts/artifacts/execution-trace.schema.json",
      events: [
        {
          ts: "2026-02-22T12:00:00Z",
          run_id: "run-nowc",
          event: "phase_start",
          phase: "design",
        },
        {
          ts: "2026-02-22T12:00:05Z",
          run_id: "run-nowc",
          event: "phase_end",
          phase: "design",
        },
      ],
    },
    [],
    { workspaceRoot },
  );

  expect(result.summary.total_wall_clock_s).toBeUndefined();

  rmSync(workspaceRoot, { recursive: true, force: true });
});

it("returns undefined for security_time_to_closure_s when no security-review phase exists", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-nosec-"));
  const schemaDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "execution-trace.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ts", "run_id", "event", "phase"],
      properties: {
        ts: { type: "string" },
        run_id: { type: "string" },
        event: { type: "string" },
        phase: { type: "string" },
      },
    }),
    "utf8",
  );

  const result = await collectTrace(
    {
      run_id: "run-nosec",
      schema_ref: "contracts/artifacts/execution-trace.schema.json",
      events: [
        {
          ts: "2026-02-22T12:00:00Z",
          run_id: "run-nosec",
          event: "phase_start",
          phase: "design",
        },
        {
          ts: "2026-02-22T12:00:05Z",
          run_id: "run-nosec",
          event: "phase_end",
          phase: "design",
        },
      ],
    },
    [],
    { workspaceRoot },
  );

  expect(result.summary.security_time_to_closure_s).toBeUndefined();

  rmSync(workspaceRoot, { recursive: true, force: true });
});

it("produces output that conforms to the shipped output schema", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "trace-collector-contract-"));
  const schemaDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "execution-trace.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ts", "run_id", "event", "phase"],
      properties: {
        ts: { type: "string" },
        run_id: { type: "string" },
        event: { type: "string" },
        phase: { type: "string" },
      },
    }),
    "utf8",
  );

  const result = await collectTrace(
    {
      run_id: "run-contract",
      schema_ref: "contracts/artifacts/execution-trace.schema.json",
      events: [
        {
          ts: "2026-02-22T12:00:00Z",
          run_id: "run-contract",
          event: "run_start",
          phase: "arm",
        },
        {
          ts: "2026-02-22T12:00:02Z",
          run_id: "run-contract",
          event: "run_end",
          phase: "arm",
        },
      ],
    },
    [],
    { workspaceRoot },
  );

  const outputSchema = JSON.parse(
    readFileSync(new URL("../../schemas/output.schema.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const ajv = await createAjvInstance();
  const validate = ajv.compile(outputSchema);
  const envelope = {
    success: true,
    data: result,
    metadata: {
      tool_version: "test",
      execution_time_ms: 1,
    },
    logs: [],
  };

  expect(validate(envelope)).toBe(true);
  expect(validate.errors ?? []).toEqual([]);

  rmSync(workspaceRoot, { recursive: true, force: true });
});
