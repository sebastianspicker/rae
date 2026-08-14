/**
 * Loads, schema-validates, and summarizes pipeline traces within workspace boundaries.
 */
import { readFileSync } from "node:fs";
import { createAjvInstance, resolveWithinWorkspace } from "@coding-agents-space/shared";
import type { Input, TraceEvent, TraceResult, TraceSummary } from "../types.js";

interface TraceOptions {
  workspaceRoot?: string;
  schemaRoot?: string;
}

type ActivityResolution = NonNullable<TraceSummary["activity_resolutions"]>[number];
type GateResults = TraceSummary["gate_results"];

interface SummaryState {
  eventsByType: Record<string, number>;
  gateResults: GateResults;
  phaseStarts: Map<string, number>;
  phaseDurations: Record<string, number>;
  activityResolutions: Map<string, ActivityResolution>;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  failures: number;
  retries: number;
}

export function readJsonlEvents(tracePath: string): TraceEvent[] {
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as TraceEvent;
    } catch (error) {
      throw Object.assign(new Error(`Invalid JSONL at line ${idx + 1}: ${String(error)}`), {
        code: "E_BAD_TRACE",
      });
    }
  });
}

function createSummaryState(): SummaryState {
  return {
    eventsByType: {},
    gateResults: { pass: 0, fail: 0, warn: 0 },
    phaseStarts: new Map<string, number>(),
    phaseDurations: {},
    activityResolutions: new Map<string, ActivityResolution>(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    failures: 0,
    retries: 0,
  };
}

function resolvedString(
  directValue: unknown,
  metadata: Record<string, unknown> | undefined,
  metadataKey: string,
): string | undefined {
  if (typeof directValue === "string") return directValue;
  const metadataValue = metadata?.[metadataKey];
  return typeof metadataValue === "string" ? metadataValue : undefined;
}

function recordActivityResolution(
  event: TraceEvent,
  resolutions: Map<string, ActivityResolution>,
): void {
  const activityId = resolvedString(event.activity_id, event.metadata, "activity_id");
  if (!activityId) return;
  const resolution = resolutions.get(activityId) ?? {
    activity_id: activityId,
    tier: resolvedString(event.tier, event.metadata, "cognitive_tier"),
    model_hint: resolvedString(event.model_hint, event.metadata, "model_hint"),
    runtime_name: resolvedString(event.runtime_name, event.metadata, "runtime_name"),
    runtime_version: resolvedString(event.runtime_version, event.metadata, "runtime_version"),
    count: 0,
  };
  resolution.count += 1;
  resolutions.set(activityId, resolution);
}

function recordPhaseTiming(event: TraceEvent, state: SummaryState, issues: string[]): void {
  if (event.event === "phase_start") {
    const timestamp = Date.parse(event.ts);
    if (!Number.isNaN(timestamp)) state.phaseStarts.set(event.phase, timestamp);
    return;
  }
  if (event.event !== "phase_end") return;

  const timestamp = Date.parse(event.ts);
  const start = state.phaseStarts.get(event.phase);
  if (start === undefined || Number.isNaN(timestamp) || timestamp < start) {
    issues.push(`phase_end without matching phase_start: ${event.phase}`);
    return;
  }
  state.phaseDurations[event.phase] =
    (state.phaseDurations[event.phase] ?? 0) + (timestamp - start);
}

function recordGateResult(event: TraceEvent, gateResults: GateResults): void {
  if (event.event !== "gate_result") return;
  if (event.status === "pass") gateResults.pass++;
  else if (event.status === "fail") gateResults.fail++;
  else if (event.status === "warn") gateResults.warn++;
}

function recordEvent(event: TraceEvent, state: SummaryState, issues: string[]): void {
  state.eventsByType[event.event] = (state.eventsByType[event.event] ?? 0) + 1;
  recordActivityResolution(event, state.activityResolutions);
  recordPhaseTiming(event, state, issues);
  recordGateResult(event, state.gateResults);
  if (event.event === "error") state.failures++;
  if (event.event === "retry") state.retries++;
  if (typeof event.tokens_in === "number") state.totalTokensIn += Math.max(0, event.tokens_in);
  if (typeof event.tokens_out === "number") state.totalTokensOut += Math.max(0, event.tokens_out);
  if (typeof event.cost_usd === "number") state.totalCostUsd += Math.max(0, event.cost_usd);
}

function recordUnmatchedPhaseStarts(state: SummaryState, issues: string[]): void {
  for (const phase of state.phaseStarts.keys()) {
    if (!(phase in state.phaseDurations)) {
      issues.push(`phase_start without matching phase_end: ${phase}`);
    }
  }
}

function wallClockDuration(events: TraceEvent[], issues: string[]): number | undefined {
  const runStart = events.find((event) => event.event === "run_start");
  const runEnd = events.find((event) => event.event === "run_end");
  if (!runStart || !runEnd) return undefined;

  const startTimestamp = Date.parse(runStart.ts);
  const endTimestamp = Date.parse(runEnd.ts);
  if (Number.isNaN(startTimestamp) || Number.isNaN(endTimestamp)) {
    issues.push("invalid run_start or run_end timestamp");
    return undefined;
  }
  if (endTimestamp < startTimestamp) {
    issues.push("run_end precedes run_start");
    return undefined;
  }
  return endTimestamp - startTimestamp;
}

export function buildSummary(events: TraceEvent[], issues: string[]): TraceSummary {
  const state = createSummaryState();
  for (const event of events) recordEvent(event, state, issues);
  recordUnmatchedPhaseStarts(state, issues);

  const totalDurationMs = Object.values(state.phaseDurations).reduce(
    (acc, value) => acc + value,
    0,
  );
  const wallClockMs = wallClockDuration(events, issues);

  return {
    total_events: events.length,
    events_by_type: state.eventsByType,
    gate_results: state.gateResults,
    phase_durations_ms: state.phaseDurations,
    activity_resolutions: [...state.activityResolutions.values()].sort((a, b) =>
      String(a.activity_id).localeCompare(String(b.activity_id)),
    ),
    total_tokens_in: state.totalTokensIn,
    total_tokens_out: state.totalTokensOut,
    total_cost_usd: Number(state.totalCostUsd.toFixed(6)),
    failure_count: state.failures,
    retry_count: state.retries,
    /** @deprecated Use summed_phase_duration_s instead. This sums phase durations, not wall-clock time. */
    total_duration_s: totalDurationMs > 0 ? Number((totalDurationMs / 1000).toFixed(3)) : undefined,
    summed_phase_duration_s:
      totalDurationMs > 0 ? Number((totalDurationMs / 1000).toFixed(3)) : undefined,
    total_wall_clock_s:
      wallClockMs !== undefined ? Number((wallClockMs / 1000).toFixed(3)) : undefined,
    security_time_to_closure_s:
      "security-review" in state.phaseDurations
        ? Number((state.phaseDurations["security-review"] / 1000).toFixed(3))
        : undefined,
  };
}

/**
 * Collects trace events from workspace-contained files and returns schema-backed summary metrics.
 */
export async function collectTrace(
  input: Input,
  logs: string[],
  opts: TraceOptions = {},
): Promise<TraceResult> {
  const workspaceRoot = opts.workspaceRoot ?? "/workspace";
  const schemaRoot = opts.schemaRoot ?? workspaceRoot;
  const schemaRef = input.schema_ref ?? "contracts/artifacts/execution-trace.schema.json";
  const schema = loadTraceSchema(schemaRoot, schemaRef);
  const events = loadTraceEvents(input, workspaceRoot, logs);
  const validate = (await createAjvInstance()).compile(schema);
  const issues: string[] = [];
  events.forEach((event, index) => {
    validateTraceEvent(event, index, input.run_id, validate, issues);
  });

  const summary = buildSummary(events, issues);
  return {
    run_id: input.run_id,
    valid: issues.length === 0,
    issues,
    summary,
  };
}

export function loadTraceSchema(schemaRoot: string, schemaRef: string): Record<string, unknown> {
  const schemaPath = resolveWithinWorkspace(schemaRoot, schemaRef, "Path", {
    rootLabel: "schema root",
  });
  return JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

export function loadTraceEvents(input: Input, workspaceRoot: string, logs: string[]): TraceEvent[] {
  if (!input.trace_path) {
    const events = input.events ?? [];
    logs.push(`Loaded inline trace events: ${events.length}`);
    return events;
  }
  const tracePath = resolveWithinWorkspace(workspaceRoot, input.trace_path, "Path", {
    rootLabel: "workspace root",
  });
  logs.push(`Loaded trace events from ${tracePath}`);
  return readJsonlEvents(tracePath);
}

export function validateTraceEvent(
  event: TraceEvent,
  index: number,
  runId: string,
  validate: {
    (value: unknown): boolean;
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  },
  issues: string[],
): void {
  if (!validate(event))
    issues.push(`event[${index}] schema violation: ${formatSchemaErrors(validate.errors)}`);
  if (event.run_id !== runId)
    issues.push(`event[${index}] run_id mismatch: expected ${runId}, got ${event.run_id}`);
}

export function formatSchemaErrors(
  errors: Array<{ instancePath?: string; message?: string }> | null | undefined,
): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
